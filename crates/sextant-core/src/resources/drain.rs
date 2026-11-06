//! Draining a node, as `kubectl drain` does: cordon it, plan which pods go, evict
//! them through the Eviction API, and wait until they are gone.

use std::collections::BTreeSet;
use std::time::Duration;

use dashmap::mapref::entry::Entry;
use futures::stream::{self, StreamExt};
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

fn text<'a>(pod: &'a Value, pointer: &str) -> Option<&'a str> {
    pod.pointer(pointer).and_then(Value::as_str)
}

fn controller_kind(pod: &Value) -> Option<&str> {
    pod.pointer("/metadata/ownerReferences")?
        .as_array()?
        .iter()
        .find(|owner| owner.get("controller").and_then(Value::as_bool) == Some(true))
        .map(|owner| {
            owner
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or_default()
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
fn plan_drain(pods: &[Value], options: &DrainOptions) -> DrainPlan {
    let mut plan = DrainPlan::default();
    for pod in pods {
        let reference = PodRef {
            namespace: text(pod, "/metadata/namespace")
                .unwrap_or_default()
                .to_owned(),
            name: text(pod, "/metadata/name").unwrap_or_default().to_owned(),
        };
        let controller = controller_kind(pod);
        let skip_reason = if is_mirror(pod) {
            Some(SkipReason::Mirror)
        } else if controller == Some("DaemonSet") {
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
        if !matches!(text(pod, "/status/phase"), Some("Succeeded" | "Failed")) {
            let path = reference.path();
            let mut blocked = false;
            if uses_empty_dir(pod) && !options.delete_empty_dir {
                plan.blockers.push(format!(
                    "{path} uses emptyDir storage; its data would be lost"
                ));
                blocked = true;
            }
            if controller.is_none() && !options.force {
                plan.blockers.push(format!(
                    "{path} has no controller, so nothing would recreate it"
                ));
                blocked = true;
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

/// Why a pod's eviction ended.
enum PodEnd {
    Gone,
    Failed,
}

/// Evicts one pod, retrying while a disruption budget refuses, and waits until it
/// is gone. `IpcError` maps 429 to `Unreachable`, so this works on the raw error.
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
        let request = match eviction_request(&pod.namespace, &pod.name) {
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
            Err(error) => {
                report(failed(IpcError::from(error).message)).await;
                return PodEnd::Failed;
            }
        }
    }
    loop {
        tokio::time::sleep(DELETE_POLL).await;
        let gone = match read_pod(client, pod).await {
            Err(kube::Error::Api(status)) => status.code == 404,
            Ok(current) => pod_uid(&current) != planned.uid.as_deref(),
            Err(_) => false,
        };
        if gone {
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
    let plan = plan_drain(&pods, options);
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

    #[test]
    fn managed_pods_are_evicted() {
        let plan = plan_drain(&[pod("a", owned("ReplicaSet"))], &NO_OPTIONS);
        assert_eq!(names(&plan.evict), ["a"]);
        assert!(plan.blockers.is_empty());
    }

    #[test]
    fn daemonset_and_mirror_pods_are_skipped() {
        let mirror =
            json!({ "metadata": { "annotations": { "kubernetes.io/config.mirror": "x" } } });
        let plan = plan_drain(
            &[pod("d", owned("DaemonSet")), pod("m", mirror)],
            &NO_OPTIONS,
        );
        assert!(plan.evict.is_empty() && plan.blockers.is_empty());
        assert_eq!(plan.skipped.len(), 2);
    }

    #[test]
    fn an_unmanaged_pod_blocks_without_force() {
        let plan = plan_drain(&[pod("u", json!({}))], &NO_OPTIONS);
        assert!(plan.blockers[0].contains("n/u"));
        let forced = DrainOptions {
            force: true,
            ..NO_OPTIONS
        };
        assert_eq!(
            names(&plan_drain(&[pod("u", json!({}))], &forced).evict),
            ["u"]
        );
    }

    #[test]
    fn an_empty_dir_pod_blocks_without_the_option() {
        let extra = json!({ "spec": { "volumes": [{ "name": "v", "emptyDir": {} }] } });
        let mut with_owner = pod("e", extra);
        json_patch_merge(&mut with_owner, &owned("ReplicaSet"));
        assert!(
            plan_drain(std::slice::from_ref(&with_owner), &NO_OPTIONS).blockers[0].contains("n/e")
        );
        let allowed = DrainOptions {
            delete_empty_dir: true,
            ..NO_OPTIONS
        };
        assert_eq!(names(&plan_drain(&[with_owner], &allowed).evict), ["e"]);
    }

    #[test]
    fn a_finished_pod_never_blocks() {
        for phase in ["Succeeded", "Failed"] {
            let plan = plan_drain(
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
        let plan = plan_drain(&[pod("b", extra)], &NO_OPTIONS);
        assert_eq!(plan.blockers.len(), 2);
    }

    #[test]
    fn an_owner_that_is_not_the_controller_does_not_manage_the_pod() {
        let extra = json!({ "metadata": { "ownerReferences": [{ "kind": "ReplicaSet", "name": "o", "uid": "u" }] } });
        let plan = plan_drain(&[pod("o", extra)], &NO_OPTIONS);
        assert_eq!(plan.blockers.len(), 1);
    }

    #[test]
    fn the_listed_uid_is_kept_for_the_wait() {
        let extra = json!({ "metadata": { "uid": "listed" } });
        let mut with_owner = pod("a", extra);
        json_patch_merge(&mut with_owner, &owned("ReplicaSet"));
        let plan = plan_drain(&[with_owner], &NO_OPTIONS);
        assert_eq!(plan.evict[0].uid.as_deref(), Some("listed"));
    }

    #[test]
    fn a_pod_with_almost_nothing_in_it_does_not_panic() {
        let plan = plan_drain(&[json!({})], &NO_OPTIONS);
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
