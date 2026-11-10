//! The logs of a workload. Its pods come from `spec.selector`: a single list when reading
//! once, and a watch when following, so new pods join the stream.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use futures::StreamExt;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::LabelSelector;
use kube::api::{ApiResource, DynamicObject, ListParams};
use kube::core::{GroupVersionKind, Selector};
use kube::runtime::watcher::{self, watcher, Event};
use kube::Api;
use serde_json::Value;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use super::super::pod_container_names;
use super::follow::{stream_container, ContainerEnd, StreamContext, StreamTarget};
use super::{run_streams, LogEndReason, LogEvent, LogMarker, StreamItem};
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::resources::{invalid, ResourceRef};

const MIN_BACKOFF: Duration = Duration::from_secs(1);
const MAX_BACKOFF: Duration = Duration::from_secs(30);

/// The kinds with logs of their own pods: `(group, plural)`.
const WORKLOADS: [(&str, &str); 5] = [
    ("apps", "deployments"),
    ("apps", "statefulsets"),
    ("apps", "daemonsets"),
    ("apps", "replicasets"),
    ("batch", "jobs"),
];

pub(super) fn is_workload(resource: &ResourceRef) -> bool {
    WORKLOADS.contains(&(resource.group.as_str(), resource.plural.as_str()))
}

/// The selector in `spec.selector`. An empty one would select every pod in the namespace,
/// which no workload means.
pub(crate) fn workload_selector(workload: &Value) -> CoreResult<Selector> {
    let raw = workload
        .pointer("/spec/selector")
        .cloned()
        .ok_or_else(|| invalid("the workload has no pod selector"))?;
    let parsed: LabelSelector = serde_json::from_value(raw)
        .map_err(|_| invalid("the workload's pod selector cannot be read"))?;
    let selector = Selector::try_from(parsed)
        .map_err(|_| invalid("the workload's pod selector cannot be read"))?;
    if selector.selects_all() {
        return Err(invalid("the workload has an empty pod selector"));
    }
    Ok(selector)
}

fn pod_api(context: &StreamContext) -> Api<DynamicObject> {
    let resource =
        ApiResource::from_gvk_with_plural(&GroupVersionKind::gvk("", "v1", "Pod"), "pods");
    Api::namespaced_with(context.client.clone(), &context.namespace, &resource)
}

async fn read_selector(
    context: &StreamContext,
    resource: &ResourceRef,
    name: &str,
) -> CoreResult<Selector> {
    let gvk = GroupVersionKind::gvk(&resource.group, &resource.version, &resource.kind);
    let api_resource = ApiResource::from_gvk_with_plural(&gvk, &resource.plural);
    let workloads: Api<DynamicObject> =
        Api::namespaced_with(context.client.clone(), &context.namespace, &api_resource);
    let workload = workloads.get(name).await?;
    workload_selector(&workload.data)
}

/// What to stream from one pod. A named container is skipped on a pod without it, because
/// a rollout can leave pods of another template behind.
fn targets_of(pod: &DynamicObject, container: Option<&str>) -> Vec<StreamTarget> {
    let Some(name) = pod.metadata.name.as_deref() else {
        return Vec::new();
    };
    pod_container_names(&pod.data)
        .into_iter()
        .filter(|declared| container.is_none_or(|wanted| wanted == declared))
        .map(|container| StreamTarget {
            pod: name.to_owned(),
            container,
        })
        .collect()
}

async fn read_once(
    context: StreamContext,
    selector: Selector,
    container: Option<&str>,
) -> LogEvent {
    let params = ListParams::default().labels_from(&selector);
    let pods = pod_api(&context);
    let listed = tokio::select! {
        () = context.token.cancelled() => {
            return LogEvent::Ended { reason: LogEndReason::Stopped };
        }
        listed = pods.list(&params) => listed,
    };
    match listed {
        Ok(pods) => {
            let targets = pods
                .items
                .iter()
                .flat_map(|pod| targets_of(pod, container))
                .collect();
            run_streams(context, targets).await
        }
        Err(error) => LogEvent::Failed {
            error: error.into(),
        },
    }
}

struct FollowedPod {
    uid: Option<String>,
    token: CancellationToken,
}

/// The pods being streamed, and the streams themselves.
struct Followed {
    context: StreamContext,
    container: Option<String>,
    pods: HashMap<String, FollowedPod>,
    streams: JoinSet<(StreamTarget, ContainerEnd)>,
}

impl Followed {
    async fn pod_marker(&self, pod: &str, marker: LogMarker) {
        self.watch_marker(pod, marker, None).await;
    }

    async fn watch_marker(&self, pod: &str, marker: LogMarker, message: Option<String>) {
        let item = StreamItem::Marker {
            pod: pod.to_owned(),
            container: None,
            marker,
            message,
        };
        // Only fails once the batcher has gone, and that stops the session anyway.
        let _ = self.context.items.send(item).await;
    }

    /// Starts streaming a pod not seen before. The same name with another uid is a new pod.
    async fn apply(&mut self, pod: &DynamicObject, announce: bool) {
        let Some(name) = pod.metadata.name.clone() else {
            return;
        };
        if let Some(known) = self.pods.get(&name) {
            if known.uid == pod.metadata.uid {
                return;
            }
            self.remove(&name).await;
        }
        if announce {
            self.pod_marker(&name, LogMarker::PodAdded).await;
        }
        let token = self.context.token.child_token();
        for target in targets_of(pod, self.container.as_deref()) {
            let mut context = self.context.clone();
            context.token = token.clone();
            context.follow_replacements = false;
            self.streams
                .spawn(async move { (target.clone(), stream_container(context, target).await) });
        }
        let uid = pod.metadata.uid.clone();
        self.pods.insert(name, FollowedPod { uid, token });
    }

    async fn remove(&mut self, name: &str) {
        if let Some(pod) = self.pods.remove(name) {
            pod.token.cancel();
            self.pod_marker(name, LogMarker::PodRemoved).await;
        }
    }

    /// After a new list: whatever it left out is gone.
    async fn keep_only(&mut self, listed: &HashSet<String>) {
        let gone: Vec<String> = self
            .pods
            .keys()
            .filter(|name| !listed.contains(*name))
            .cloned()
            .collect();
        for name in gone {
            self.remove(&name).await;
        }
    }

    /// One stream failing leaves the rest of the workload's streams running.
    async fn report(&self, target: &StreamTarget, end: ContainerEnd) {
        if let ContainerEnd::Failed(error) = end {
            self.context
                .marker(target, LogMarker::Failed, Some(error.message))
                .await;
        }
    }
}

/// The API server's status code behind a watcher error.
fn watch_failure(error: watcher::Error) -> (Option<u16>, IpcError) {
    let source = match error {
        watcher::Error::InitialListFailed(source)
        | watcher::Error::WatchStartFailed(source)
        | watcher::Error::WatchFailed(source) => source,
        watcher::Error::WatchError(status) => kube::Error::Api(status),
        watcher::Error::NoResourceVersion => {
            return (
                None,
                IpcError::new(
                    ErrorCode::Internal,
                    "the pod watch answered without a resource version",
                ),
            );
        }
    };
    let code = match &source {
        kube::Error::Api(status) => Some(status.code),
        _ => None,
    };
    (code, source.into())
}

async fn follow_pods(
    context: StreamContext,
    selector: Selector,
    container: Option<String>,
    workload: &str,
) -> LogEvent {
    let token = context.token.clone();
    let config = watcher::Config::default().labels_from(&selector);
    let mut watch = watcher(pod_api(&context), config).boxed();
    let mut followed = Followed {
        context,
        container,
        pods: HashMap::new(),
        streams: JoinSet::new(),
    };
    let mut listing = HashSet::new();
    let mut listed = false;
    let mut backoff = MIN_BACKOFF;
    let mut reconnecting = false;
    loop {
        tokio::select! {
            () = token.cancelled() => break,
            Some(joined) = followed.streams.join_next() => {
                if let Ok((target, end)) = joined {
                    followed.report(&target, end).await;
                }
            }
            event = watch.next() => {
                if matches!(event, Some(Ok(_))) && std::mem::take(&mut reconnecting) {
                    followed.watch_marker(workload, LogMarker::Reconnected, None).await;
                }
                match event {
                Some(Ok(Event::Init)) => listing.clear(),
                Some(Ok(Event::InitApply(pod))) => {
                    if let Some(name) = pod.metadata.name.clone() {
                        listing.insert(name);
                    }
                    // Pods there at the start are not news; pods in a later list are.
                    followed.apply(&pod, listed).await;
                }
                Some(Ok(Event::InitDone)) => {
                    followed.keep_only(&listing).await;
                    listed = true;
                    backoff = MIN_BACKOFF;
                }
                Some(Ok(Event::Apply(pod))) => followed.apply(&pod, true).await,
                Some(Ok(Event::Delete(pod))) => {
                    if let Some(name) = pod.metadata.name.as_deref() {
                        followed.remove(name).await;
                    }
                }
                Some(Err(error)) => {
                    let (code, error) = watch_failure(error);
                    if matches!(code, Some(401 | 403)) {
                        return LogEvent::Failed { error };
                    }
                    if !std::mem::replace(&mut reconnecting, true) {
                        followed
                            .watch_marker(workload, LogMarker::Reconnecting, Some(error.message))
                            .await;
                    }
                    let pause = backoff;
                    backoff = (backoff * 2).min(MAX_BACKOFF);
                    tokio::select! {
                        () = token.cancelled() => break,
                        () = tokio::time::sleep(pause) => {}
                    }
                }
                None => break,
                }
            },
        }
    }
    while let Some(joined) = followed.streams.join_next().await {
        if let Ok((target, end)) = joined {
            followed.report(&target, end).await;
        }
    }
    LogEvent::Ended {
        reason: LogEndReason::Stopped,
    }
}

pub(super) async fn run_workload_target(
    context: StreamContext,
    resource: ResourceRef,
    name: String,
    container: Option<String>,
) -> LogEvent {
    let selector = match read_selector(&context, &resource, &name).await {
        Ok(selector) => selector,
        Err(error) => return LogEvent::Failed { error },
    };
    if context.options.follow && !context.options.previous {
        follow_pods(context, selector, container, &name).await
    } else {
        read_once(context, selector, container.as_deref()).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn resource(group: &str, plural: &str) -> ResourceRef {
        ResourceRef {
            group: group.into(),
            version: "v1".into(),
            plural: plural.into(),
            kind: "Any".into(),
            namespaced: true,
        }
    }

    #[test]
    fn only_the_five_workload_kinds_are_accepted() {
        for (group, plural) in WORKLOADS {
            assert!(is_workload(&resource(group, plural)));
        }
        assert!(!is_workload(&resource("batch", "cronjobs")));
        assert!(!is_workload(&resource("", "pods")));
        assert!(!is_workload(&resource("example.com", "deployments")));
    }

    #[test]
    fn match_labels_and_expressions_both_select() {
        let selector = workload_selector(&json!({ "spec": { "selector": {
            "matchLabels": { "app": "web" },
            "matchExpressions": [{ "key": "tier", "operator": "In", "values": ["a", "b"] }],
        } } }))
        .unwrap();
        let text = selector.to_string();
        assert!(text.contains("app=web"), "{text}");
        assert!(text.contains("tier in (a,b)"), "{text}");
    }

    #[test]
    fn a_missing_or_empty_selector_is_refused() {
        for workload in [
            json!({ "spec": {} }),
            json!({ "spec": { "selector": {} } }),
            json!({ "spec": { "selector": { "matchLabels": {} } } }),
        ] {
            let error = workload_selector(&workload).unwrap_err();
            assert_eq!(error.code, ErrorCode::InvalidInput, "{workload}");
        }
    }
}
