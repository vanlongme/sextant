//! Draining a node, as `kubectl drain` does: cordon it, plan which pods go, evict
//! them through the Eviction API, and wait until they are gone.

use std::collections::{btree_map, BTreeMap, BTreeSet};
use std::time::Duration;

use dashmap::mapref::entry::Entry;
use futures::stream::{self, StreamExt};
use k8s_openapi::api::apps::v1::DaemonSet;
use k8s_openapi::api::core::v1::Pod;
use kube::api::{GetParams, ListParams};
use kube::core::{Request, Resource};
use kube::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use ts_rs::TS;

use super::actions::eviction_request;
use super::ops::{invalid, is_path_segment, selector_value};
use crate::app_core::AppCore;
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::kubeconfig::ClusterId;

const EVICT_RETRY: Duration = Duration::from_secs(5);
const DELETE_POLL: Duration = Duration::from_secs(1);
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_EVICTING: usize = 10;
const MIRROR_ANNOTATION: &str = "kubernetes.io/config.mirror";
const DAEMON_SET_API_VERSION: &str = "apps/v1";

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct DrainOptions {
    /// Also evict pods that no controller would recreate.
    pub force: bool,
    /// Also evict pods whose `emptyDir` data would be lost.
    pub delete_empty_dir: bool,
    /// How long the evictions may take. Without it, five minutes.
    // Not `u64`, which `ts-rs` exports as `bigint`.
    pub timeout_seconds: Option<u32>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PodRef {
    pub namespace: String,
    pub name: String,
}

impl PodRef {
    fn path(&self) -> String {
        format!("{}/{}", self.namespace, self.name)
    }
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum SkipReason {
    DaemonSet,
    Mirror,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SkippedPod {
    pub pod: PodRef,
    pub reason: SkipReason,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum DrainOutcome {
    Completed,
    Refused,
    Failed,
    TimedOut,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DrainEvent {
    Cordoned,
    Planned {
        evict: Vec<PodRef>,
        skipped: Vec<SkippedPod>,
    },
    PodEvicting {
        pod: PodRef,
    },
    PodBlocked {
        pod: PodRef,
        message: String,
    },
    PodGone {
        pod: PodRef,
    },
    PodFailed {
        pod: PodRef,
        message: String,
    },
    Finished {
        outcome: DrainOutcome,
        message: Option<String>,
    },
}

/// A drain in progress, under its cluster and node.
pub(crate) struct RunningDrain {
    id: String,
    token: CancellationToken,
}

#[derive(Debug)]
struct PlannedEviction {
    pod: PodRef,
    /// From the listing, because a pod recreated under the same name has another.
    uid: Option<String>,
}

#[derive(Debug, Default)]
struct DrainPlan {
    evict: Vec<PlannedEviction>,
    skipped: Vec<SkippedPod>,
    blockers: Vec<String>,
}

/// The DaemonSet a pod names as its controller.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct DaemonSetKey {
    namespace: String,
    name: String,
    uid: String,
}

/// What reading a pod's DaemonSet found. `kubectl drain` skips the pod when it exists,
/// treats the pod as an orphan when it does not, and refuses when it cannot tell.
#[derive(Debug, Clone, PartialEq, Eq)]
enum DaemonSetCheck {
    Live,
    Orphaned,
    Unreadable(String),
}

type DaemonSetChecks = BTreeMap<DaemonSetKey, DaemonSetCheck>;

fn text<'a>(pod: &'a Value, pointer: &str) -> Option<&'a str> {
    pod.pointer(pointer).and_then(Value::as_str)
}

fn controller_ref(pod: &Value) -> Option<&Value> {
    pod.pointer("/metadata/ownerReferences")?
        .as_array()?
        .iter()
        .find(|owner| owner.get("controller").and_then(Value::as_bool) == Some(true))
}

fn is_finished(pod: &Value) -> bool {
    matches!(text(pod, "/status/phase"), Some("Succeeded" | "Failed"))
}

/// The DaemonSet to check for this pod. As in `kubectl drain`, a finished pod needs no
/// check, and a kind of the same name from another API group is an ordinary controller.
fn daemon_set_key(pod: &Value) -> Option<DaemonSetKey> {
    let owner = controller_ref(pod)?;
    let is_daemon_set = text(owner, "/kind") == Some("DaemonSet")
        && text(owner, "/apiVersion") == Some(DAEMON_SET_API_VERSION);
    if !is_daemon_set || is_finished(pod) {
        return None;
    }
    Some(DaemonSetKey {
        namespace: text(pod, "/metadata/namespace")
            .unwrap_or_default()
            .to_owned(),
        name: text(owner, "/name").unwrap_or_default().to_owned(),
        uid: text(owner, "/uid").unwrap_or_default().to_owned(),
    })
}

fn is_mirror(pod: &Value) -> bool {
    pod.pointer("/metadata/annotations")
        .and_then(|annotations| annotations.get(MIRROR_ANNOTATION))
        .is_some()
}

fn uses_empty_dir(pod: &Value) -> bool {
    pod.pointer("/spec/volumes")
        .and_then(Value::as_array)
        .is_some_and(|volumes| {
            volumes
                .iter()
                .any(|volume| volume.get("emptyDir").is_some())
        })
}

/// Decides what happens to each pod, by the rules of `kubectl drain`.
fn plan_drain(pods: &[Value], options: &DrainOptions, daemon_sets: &DaemonSetChecks) -> DrainPlan {
    let mut plan = DrainPlan::default();
    for pod in pods {
        let reference = PodRef {
            namespace: text(pod, "/metadata/namespace")
                .unwrap_or_default()
                .to_owned(),
            name: text(pod, "/metadata/name").unwrap_or_default().to_owned(),
        };
        let daemon_set = daemon_set_key(pod);
        let check = daemon_set.as_ref().and_then(|key| daemon_sets.get(key));
        let skip_reason = if is_mirror(pod) {
            Some(SkipReason::Mirror)
        } else if check == Some(&DaemonSetCheck::Live) {
            Some(SkipReason::DaemonSet)
        } else {
            None
        };
        if let Some(reason) = skip_reason {
            plan.skipped.push(SkippedPod {
                pod: reference,
                reason,
            });
            continue;
        }
        if !is_finished(pod) {
            let path = reference.path();
            let mut blocked = false;
            if uses_empty_dir(pod) && !options.delete_empty_dir {
                plan.blockers.push(format!(
                    "{path} uses emptyDir storage; its data would be lost"
                ));
                blocked = true;
            }
            if controller_ref(pod).is_none() && !options.force {
                plan.blockers.push(format!(
                    "{path} has no controller, so nothing would recreate it"
                ));
                blocked = true;
            }
            let owner = daemon_set.as_ref().map_or("", |key| key.name.as_str());
            match check {
                Some(DaemonSetCheck::Orphaned) if !options.force => {
                    plan.blockers.push(format!(
                        "{path} names DaemonSet {owner} as its controller, but that DaemonSet does not exist"
                    ));
                    blocked = true;
                }
                Some(DaemonSetCheck::Unreadable(message)) => {
                    plan.blockers.push(format!(
                        "could not read DaemonSet {owner} of {path}: {message}"
                    ));
                    blocked = true;
                }
                _ => {}
            }
            if blocked {
                continue;
            }
        }
        plan.evict.push(PlannedEviction {
            pod: reference,
            uid: pod_uid(pod).map(str::to_owned),
        });
    }
    plan
}

fn pod_uid(pod: &Value) -> Option<&str> {
    text(pod, "/metadata/uid")
}

fn finished(outcome: DrainOutcome, message: Option<String>) -> DrainEvent {
    DrainEvent::Finished { outcome, message }
}

async fn list_pods_on(client: &Client, node: &str) -> Result<Vec<Value>, kube::Error> {
    let params = ListParams::default().fields(&format!("spec.nodeName={}", selector_value(node)));
    let request = Request::new(Pod::url_path(&(), None))
        .list(&params)
        .map_err(kube::Error::BuildRequest)?;
    let mut list: Value = client.request(request).await?;
    Ok(match list.get_mut("items").map(Value::take) {
        Some(Value::Array(items)) => items,
        _ => Vec::new(),
    })
}

async fn read_pod(client: &Client, pod: &PodRef) -> Result<Value, kube::Error> {
    let request = Request::new(Pod::url_path(&(), Some(&pod.namespace)))
        .get(&pod.name, &GetParams::default())
        .map_err(kube::Error::BuildRequest)?;
    client.request(request).await
}

/// Whether the planned pod has left, even if another now holds its name.
async fn pod_is_gone(client: &Client, planned: &PlannedEviction) -> bool {
    match read_pod(client, &planned.pod).await {
        Err(kube::Error::Api(status)) => status.code == 404,
        Ok(current) => pod_uid(&current) != planned.uid.as_deref(),
        Err(_) => false,
    }
}

/// Stricter than `kubectl drain`, which goes by name alone: a controller reference is
/// only as good as the pod's author, and a false one would keep the pod on the node.
async fn check_daemon_set(client: &Client, key: &DaemonSetKey) -> DaemonSetCheck {
    if !is_path_segment(&key.name) {
        return DaemonSetCheck::Orphaned;
    }
    let request = Request::new(DaemonSet::url_path(&(), Some(&key.namespace)))
        .get(&key.name, &GetParams::default())
        .map_err(kube::Error::BuildRequest);
    let found = match request {
        Ok(request) => client.request::<Value>(request).await,
        Err(error) => Err(error),
    };
    match found {
        Ok(daemon_set) if text(&daemon_set, "/metadata/uid") == Some(key.uid.as_str()) => {
            DaemonSetCheck::Live
        }
        Ok(_) => DaemonSetCheck::Orphaned,
        Err(kube::Error::Api(status)) if status.code == 404 => DaemonSetCheck::Orphaned,
        Err(error) => DaemonSetCheck::Unreadable(IpcError::from(error).message),
    }
}

async fn check_daemon_sets(client: &Client, pods: &[Value]) -> DaemonSetChecks {
    let mut checks = DaemonSetChecks::new();
    for key in pods.iter().filter_map(daemon_set_key) {
        if let btree_map::Entry::Vacant(slot) = checks.entry(key) {
            let check = check_daemon_set(client, slot.key()).await;
            slot.insert(check);
        }
    }
    checks
}

/// Why a pod's eviction ended.
enum PodEnd {
    Gone,
    Failed,
}

/// Evicts one pod, retrying while a disruption budget refuses, and waits until it
/// is gone. `IpcError` maps 429 to `Unreachable`, so this works on the raw error.
fn namespace_terminating(status: &kube::core::Status) -> bool {
    status.code == 403
        && status.details.as_ref().is_some_and(|details| {
            details
                .causes
                .iter()
                .any(|cause| cause.reason == "NamespaceTerminating")
        })
}

async fn evict_until_gone(
    client: &Client,
    planned: &PlannedEviction,
    tx: &mpsc::Sender<DrainEvent>,
) -> PodEnd {
    let pod = &planned.pod;
    let report = |event| async { tx.send(event).await.ok() };
    report(DrainEvent::PodEvicting { pod: pod.clone() }).await;
    let failed = |message: String| DrainEvent::PodFailed {
        pod: pod.clone(),
        message,
    };
    loop {
        // The uid keeps a retry from evicting a pod recreated under the same name, which
        // `kubectl drain` would, since a cordoned node sends that pod to another node.
        let request = match eviction_request(&pod.namespace, &pod.name, planned.uid.as_deref()) {
            Ok(request) => request,
            Err(error) => {
                report(failed(error.message)).await;
                return PodEnd::Failed;
            }
        };
        match client.request::<Value>(request).await {
            Ok(_) => break,
            Err(kube::Error::Api(status)) if status.code == 404 => {
                report(DrainEvent::PodGone { pod: pod.clone() }).await;
                return PodEnd::Gone;
            }
            Err(kube::Error::Api(status)) if status.code == 429 => {
                let message = IpcError::from(kube::Error::Api(status)).message;
                report(DrainEvent::PodBlocked {
                    pod: pod.clone(),
                    message,
                })
                .await;
                tokio::time::sleep(EVICT_RETRY).await;
            }
            // The API server refuses every eviction in a namespace being deleted, and the
            // namespace controller deletes the pod anyway, so wait for it as for an eviction.
            Err(kube::Error::Api(status)) if namespace_terminating(&status) => break,
            Err(kube::Error::Api(status)) if status.code == 409 => {
                if pod_is_gone(client, planned).await {
                    report(DrainEvent::PodGone { pod: pod.clone() }).await;
                    return PodEnd::Gone;
                }
                report(failed(IpcError::from(kube::Error::Api(status)).message)).await;
                return PodEnd::Failed;
            }
            Err(error) => {
                report(failed(IpcError::from(error).message)).await;
                return PodEnd::Failed;
            }
        }
    }
    loop {
        tokio::time::sleep(DELETE_POLL).await;
        if pod_is_gone(client, planned).await {
            report(DrainEvent::PodGone { pod: pod.clone() }).await;
            return PodEnd::Gone;
        }
    }
}

/// Runs the evictions until they end or the timeout passes. A pod that failed stays
/// among those not gone.
async fn evict_all(
    client: &Client,
    evict: &[PlannedEviction],
    timeout: Duration,
    tx: &mpsc::Sender<DrainEvent>,
) -> DrainEvent {
    let mut not_gone: BTreeSet<String> = evict.iter().map(|planned| planned.pod.path()).collect();
    let mut failed = BTreeSet::new();
    let evictions = async {
        // Built here rather than in `map`, whose closure a spawned task's `Send` check rejects.
        let pods: Vec<_> = evict
            .iter()
            .map(|planned| async move { (planned, evict_until_gone(client, planned, tx).await) })
            .collect();
        let mut ends = stream::iter(pods).buffer_unordered(MAX_EVICTING);
        while let Some((planned, end)) = ends.next().await {
            match end {
                PodEnd::Gone => {
                    not_gone.remove(&planned.pod.path());
                }
                PodEnd::Failed => {
                    failed.insert(planned.pod.path());
                }
            }
        }
    };
    let timed_out = tokio::select! {
        () = evictions => false,
        () = tokio::time::sleep(timeout) => true,
    };
    let names = |pods: &BTreeSet<String>| pods.iter().cloned().collect::<Vec<_>>().join(", ");
    if timed_out {
        let message = format!("timed out waiting for {}", names(&not_gone));
        finished(DrainOutcome::TimedOut, Some(message))
    } else if failed.is_empty() {
        finished(DrainOutcome::Completed, None)
    } else {
        let message = format!("could not evict {}", names(&failed));
        finished(DrainOutcome::Failed, Some(message))
    }
}

/// The steps of a drain, ending in the `Finished` event to send.
async fn drain_steps(
    core: &AppCore,
    client: &Client,
    id: &ClusterId,
    node: &str,
    options: &DrainOptions,
    tx: &mpsc::Sender<DrainEvent>,
) -> DrainEvent {
    if let Err(error) = core.node_set_unschedulable(id, node, true).await {
        return finished(DrainOutcome::Failed, Some(error.message));
    }
    let _ = tx.send(DrainEvent::Cordoned).await;
    let pods = match list_pods_on(client, node).await {
        Ok(pods) => pods,
        Err(error) => {
            return finished(DrainOutcome::Failed, Some(IpcError::from(error).message));
        }
    };
    let daemon_sets = check_daemon_sets(client, &pods).await;
    let plan = plan_drain(&pods, options, &daemon_sets);
    if !plan.blockers.is_empty() {
        // The cordon stays, as `kubectl drain` leaves it.
        return finished(DrainOutcome::Refused, Some(plan.blockers.join("; ")));
    }
    let planned = DrainEvent::Planned {
        evict: plan.evict.iter().map(|p| p.pod.clone()).collect(),
        skipped: plan.skipped,
    };
    let _ = tx.send(planned).await;
    let timeout = options.timeout_seconds.map_or(DEFAULT_TIMEOUT, |seconds| {
        Duration::from_secs(seconds.into())
    });
    evict_all(client, &plan.evict, timeout, tx).await
}

impl AppCore {
    /// Starts draining a node and returns the drain's id. Events go to `tx`, the last
    /// being `Finished`. By then the node is free to be drained again.
    pub async fn node_drain_start(
        &self,
        id: &ClusterId,
        node: &str,
        options: DrainOptions,
        tx: mpsc::Sender<DrainEvent>,
    ) -> CoreResult<String> {
        if !is_path_segment(node) {
            return Err(invalid("the node name is not valid"));
        }
        let client = self.cluster_client(id)?;
        // This token is already a child of the connection's own.
        let token = self.cluster_cancel_token(id)?;
        let key = (id.clone(), node.to_owned());
        let drain = self.next_drain_id();
        match self.drains().entry(key.clone()) {
            Entry::Occupied(_) => {
                return Err(IpcError::new(
                    ErrorCode::Conflict,
                    format!("node {node} is already being drained"),
                ));
            }
            Entry::Vacant(slot) => {
                slot.insert(RunningDrain {
                    id: drain.clone(),
                    token: token.clone(),
                });
            }
        }
        let core = self.clone();
        tokio::spawn(async move {
            let (cluster, node) = &key;
            let event = tokio::select! {
                event = drain_steps(&core, &client, cluster, node, &options, &tx) => event,
                () = token.cancelled() => finished(DrainOutcome::Cancelled, None),
                // Nobody is watching any more.
                () = tx.closed() => {
                    token.cancel();
                    finished(DrainOutcome::Cancelled, None)
                }
            };
            core.drains().remove(&key);
            let _ = tx.send(event).await;
        });
        Ok(drain)
    }

    /// Stops a running drain. An id that is not running is ignored.
    pub fn node_drain_cancel(&self, drain_id: &str) {
        let running = self.drains().iter().find(|entry| entry.id == drain_id);
        if let Some(running) = running {
            running.token.cancel();
        }
    }

    /// Stops every running drain, on all clusters. For when the page that started
    /// them goes away: it took their ids with it, and a Tauri channel can still be
    /// written after a reload, so nothing else would stop them.
    pub fn node_drain_cancel_all(&self) {
        for running in self.drains().iter() {
            running.token.cancel();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// RFC 7386 merge, enough to build a pod from parts.
    fn json_patch_merge(target: &mut Value, patch: &Value) {
        let Some(fields) = patch.as_object() else {
            *target = patch.clone();
            return;
        };
        if !target.is_object() {
            *target = json!({});
        }
        for (key, value) in fields {
            json_patch_merge(&mut target[key], value);
        }
    }

    fn names(pods: &[PlannedEviction]) -> Vec<&str> {
        pods.iter()
            .map(|planned| planned.pod.name.as_str())
            .collect()
    }

    fn pod(name: &str, extra: Value) -> Value {
        let mut pod = json!({ "metadata": { "name": name, "namespace": "n" }, "spec": {}, "status": { "phase": "Running" } });
        json_patch_merge(&mut pod, &extra);
        pod
    }

    fn owned(kind: &str) -> Value {
        json!({ "metadata": { "ownerReferences": [{ "kind": kind, "name": "o", "uid": "u", "controller": true }] } })
    }

    const NO_OPTIONS: DrainOptions = DrainOptions {
        force: false,
        delete_empty_dir: false,
        timeout_seconds: None,
    };

    const FORCE: DrainOptions = DrainOptions {
        force: true,
        ..NO_OPTIONS
    };

    /// A plan with no DaemonSet to consider.
    fn plan_of(pods: &[Value], options: &DrainOptions) -> DrainPlan {
        plan_drain(pods, options, &DaemonSetChecks::new())
    }

    fn daemon_pod(extra: Value) -> Value {
        let owner = json!({ "metadata": { "ownerReferences": [{ "apiVersion": "apps/v1", "kind": "DaemonSet", "name": "o", "uid": "u", "controller": true }] } });
        let mut pod = pod("d", owner);
        json_patch_merge(&mut pod, &extra);
        pod
    }

    fn checks(check: DaemonSetCheck) -> DaemonSetChecks {
        let key = daemon_set_key(&daemon_pod(json!({}))).unwrap();
        DaemonSetChecks::from([(key, check)])
    }

    #[test]
    fn managed_pods_are_evicted() {
        let plan = plan_of(&[pod("a", owned("ReplicaSet"))], &NO_OPTIONS);
        assert_eq!(names(&plan.evict), ["a"]);
        assert!(plan.blockers.is_empty());
    }

    #[test]
    fn live_daemonset_and_mirror_pods_are_skipped() {
        let mirror =
            json!({ "metadata": { "annotations": { "kubernetes.io/config.mirror": "x" } } });
        let plan = plan_drain(
            &[daemon_pod(json!({})), pod("m", mirror)],
            &NO_OPTIONS,
            &checks(DaemonSetCheck::Live),
        );
        assert!(plan.evict.is_empty() && plan.blockers.is_empty());
        assert_eq!(plan.skipped.len(), 2);
    }

    #[test]
    fn an_orphaned_daemon_set_pod_blocks_without_force() {
        let plan = plan_drain(
            &[daemon_pod(json!({}))],
            &NO_OPTIONS,
            &checks(DaemonSetCheck::Orphaned),
        );
        assert!(plan.evict.is_empty() && plan.skipped.is_empty());
        assert!(plan.blockers[0].contains("n/d"), "{:?}", plan.blockers);
    }

    #[test]
    fn force_evicts_an_orphaned_daemon_set_pod() {
        let plan = plan_drain(
            &[daemon_pod(json!({}))],
            &FORCE,
            &checks(DaemonSetCheck::Orphaned),
        );
        assert_eq!(names(&plan.evict), ["d"]);
        assert!(plan.blockers.is_empty());
    }

    #[test]
    fn an_orphaned_daemon_set_pod_still_needs_the_empty_dir_option() {
        let extra = json!({ "spec": { "volumes": [{ "name": "v", "emptyDir": {} }] } });
        let plan = plan_drain(
            &[daemon_pod(extra)],
            &FORCE,
            &checks(DaemonSetCheck::Orphaned),
        );
        assert!(plan.evict.is_empty());
        assert_eq!(plan.blockers.len(), 1);
    }

    #[test]
    fn an_unreadable_daemon_set_blocks_even_with_force() {
        let plan = plan_drain(
            &[daemon_pod(json!({}))],
            &FORCE,
            &checks(DaemonSetCheck::Unreadable("denied".to_owned())),
        );
        assert!(plan.evict.is_empty() && plan.skipped.is_empty());
        assert!(plan.blockers[0].contains("denied"), "{:?}", plan.blockers);
    }

    #[test]
    fn a_finished_daemon_set_pod_needs_no_check_and_is_evicted() {
        let finished = daemon_pod(json!({ "status": { "phase": "Succeeded" } }));
        assert_eq!(daemon_set_key(&finished), None);
        assert_eq!(names(&plan_of(&[finished], &NO_OPTIONS).evict), ["d"]);
    }

    #[test]
    fn a_daemon_set_kind_from_another_group_is_an_ordinary_controller() {
        let extra = json!({ "metadata": { "ownerReferences": [{ "apiVersion": "apps.example.com/v1", "kind": "DaemonSet", "name": "o", "uid": "u", "controller": true }] } });
        let other = pod("c", extra);
        assert_eq!(daemon_set_key(&other), None);
        assert_eq!(names(&plan_of(&[other], &NO_OPTIONS).evict), ["c"]);
    }

    #[test]
    fn an_unmanaged_pod_blocks_without_force() {
        let plan = plan_of(&[pod("u", json!({}))], &NO_OPTIONS);
        assert!(plan.blockers[0].contains("n/u"));
        let forced = DrainOptions {
            force: true,
            ..NO_OPTIONS
        };
        assert_eq!(
            names(&plan_of(&[pod("u", json!({}))], &forced).evict),
            ["u"]
        );
    }

    #[test]
    fn an_empty_dir_pod_blocks_without_the_option() {
        let extra = json!({ "spec": { "volumes": [{ "name": "v", "emptyDir": {} }] } });
        let mut with_owner = pod("e", extra);
        json_patch_merge(&mut with_owner, &owned("ReplicaSet"));
        assert!(
            plan_of(std::slice::from_ref(&with_owner), &NO_OPTIONS).blockers[0].contains("n/e")
        );
        let allowed = DrainOptions {
            delete_empty_dir: true,
            ..NO_OPTIONS
        };
        assert_eq!(names(&plan_of(&[with_owner], &allowed).evict), ["e"]);
    }

    #[test]
    fn a_finished_pod_never_blocks() {
        for phase in ["Succeeded", "Failed"] {
            let plan = plan_of(
                &[pod("f", json!({ "status": { "phase": phase } }))],
                &NO_OPTIONS,
            );
            assert_eq!(names(&plan.evict), ["f"]);
            assert!(plan.blockers.is_empty());
        }
    }

    #[test]
    fn a_pod_with_both_problems_gets_both_blockers() {
        let extra = json!({ "spec": { "volumes": [{ "name": "v", "emptyDir": {} }] } });
        let plan = plan_of(&[pod("b", extra)], &NO_OPTIONS);
        assert_eq!(plan.blockers.len(), 2);
    }

    #[test]
    fn an_owner_that_is_not_the_controller_does_not_manage_the_pod() {
        let extra = json!({ "metadata": { "ownerReferences": [{ "kind": "ReplicaSet", "name": "o", "uid": "u" }] } });
        let plan = plan_of(&[pod("o", extra)], &NO_OPTIONS);
        assert_eq!(plan.blockers.len(), 1);
    }

    #[test]
    fn the_listed_uid_is_kept_for_the_wait() {
        let extra = json!({ "metadata": { "uid": "listed" } });
        let mut with_owner = pod("a", extra);
        json_patch_merge(&mut with_owner, &owned("ReplicaSet"));
        let plan = plan_of(&[with_owner], &NO_OPTIONS);
        assert_eq!(plan.evict[0].uid.as_deref(), Some("listed"));
    }

    #[test]
    fn a_pod_with_almost_nothing_in_it_does_not_panic() {
        let plan = plan_of(&[json!({})], &NO_OPTIONS);
        assert_eq!(plan.blockers.len(), 1);
    }

    #[test]
    fn events_serialize_for_the_webview() {
        let event = DrainEvent::Finished {
            outcome: DrainOutcome::TimedOut,
            message: None,
        };
        assert_eq!(
            serde_json::to_value(event).unwrap(),
            json!({ "type": "finished", "outcome": "timedOut", "message": null })
        );
        let skipped = SkippedPod {
            pod: PodRef {
                namespace: "n".into(),
                name: "d".into(),
            },
            reason: SkipReason::DaemonSet,
        };
        assert_eq!(
            serde_json::to_value(skipped).unwrap()["reason"],
            json!("daemonSet")
        );
    }
}
