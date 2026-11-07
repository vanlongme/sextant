//! Keeps one container's log stream going: it reconnects with backoff, resumes where it
//! stopped, drops the lines a resume sends twice, and says what happened with markers.

use std::time::Duration;

use futures::AsyncReadExt;
use k8s_openapi::api::core::v1::Pod;
use k8s_openapi::jiff::Timestamp;
use kube::api::LogParams;
use kube::{Api, Client};
use serde_json::Value;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::super::read_pod;
use super::parse::{parse_line, LineSplitter, RawLine};
use super::{LogLine, LogMarker, LogOptions, StreamItem};
use crate::error::{ErrorCode, IpcError};

const MIN_BACKOFF: Duration = Duration::from_secs(1);
const MAX_BACKOFF: Duration = Duration::from_secs(30);
/// A reopened stream that stays quiet this long counts as reconnected.
const SETTLE: Duration = Duration::from_secs(2);
const READ_CHUNK: usize = 16 * 1024;

/// What every stream of a session shares.
#[derive(Clone)]
pub(super) struct StreamContext {
    pub(super) client: Client,
    pub(super) namespace: String,
    pub(super) options: LogOptions,
    pub(super) items: mpsc::Sender<StreamItem>,
    pub(super) token: CancellationToken,
}

impl StreamContext {
    pub(super) async fn marker(
        &self,
        target: &StreamTarget,
        marker: LogMarker,
        message: Option<String>,
    ) {
        let item = StreamItem::Marker {
            pod: target.pod.clone(),
            container: Some(target.container.clone()),
            marker,
            message,
        };
        // Only fails once the batcher has gone, and that stops the session anyway.
        let _ = self.items.send(item).await;
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct StreamTarget {
    pub(super) pod: String,
    pub(super) container: String,
}

#[derive(Debug)]
pub(super) enum ContainerEnd {
    /// The stream ended and no more can come.
    Completed,
    PodGone,
    Failed(IpcError),
    Stopped,
}

/// What a stream remembers across reconnects.
#[derive(Debug, Default)]
struct Progress {
    /// The newest line sent.
    last: Option<Timestamp>,
    /// How many lines sent carry exactly the `last` timestamp.
    at_last: usize,
    /// Set when a stream resumes: the boundary timestamp and how many lines at it were
    /// already sent. The replay drops those, then ends at the first newer line.
    replay: Option<(Timestamp, usize)>,
    opened: bool,
    reconnecting: bool,
    /// A line arrived since the last backoff, so the next failure starts it over.
    fresh: bool,
}

/// What a stream knows of its pod, to notice a restart or a replacement.
#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct Seen {
    uid: Option<String>,
    restarts: u64,
}

impl Seen {
    fn of(pod: &Value, container: &str) -> Self {
        Seen {
            uid: pod_uid(pod).map(str::to_owned),
            restarts: restart_count(pod, container),
        }
    }
}

fn pod_uid(pod: &Value) -> Option<&str> {
    pod.pointer("/metadata/uid").and_then(Value::as_str)
}

fn named<'a>(list: Option<&'a Value>, name: &str) -> Option<&'a Value> {
    list?
        .as_array()?
        .iter()
        .find(|entry| entry.get("name").and_then(Value::as_str) == Some(name))
}

fn container_status<'a>(pod: &'a Value, container: &str) -> Option<&'a Value> {
    named(pod.pointer("/status/containerStatuses"), container)
        .or_else(|| named(pod.pointer("/status/initContainerStatuses"), container))
}

fn restart_count(pod: &Value, container: &str) -> u64 {
    container_status(pod, container)
        .and_then(|status| status.get("restartCount"))
        .and_then(Value::as_u64)
        .unwrap_or(0)
}

fn declares(pod: &Value, container: &str) -> bool {
    named(pod.pointer("/spec/containers"), container).is_some()
        || named(pod.pointer("/spec/initContainers"), container).is_some()
}

/// Whether this container has stopped and the kubelet will not start it again.
fn finished_for_good(pod: &Value, container: &str) -> bool {
    let phase = pod.pointer("/status/phase").and_then(Value::as_str);
    if matches!(phase, Some("Succeeded" | "Failed")) {
        return true;
    }
    let Some(terminated) =
        container_status(pod, container).and_then(|status| status.pointer("/state/terminated"))
    else {
        return false;
    };
    let succeeded = terminated.get("exitCode").and_then(Value::as_i64) == Some(0);
    if let Some(init) = named(pod.pointer("/spec/initContainers"), container) {
        // A sidecar is an init container that restarts like any other container.
        let sidecar = init.get("restartPolicy").and_then(Value::as_str) == Some("Always");
        if !sidecar && succeeded {
            return true;
        }
    }
    match pod.pointer("/spec/restartPolicy").and_then(Value::as_str) {
        Some("Never") => true,
        Some("OnFailure") => succeeded,
        _ => false,
    }
}

/// What to do after a followed stream ended.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Decision {
    Done,
    Fail(IpcError),
    /// Same pod with a new container, or a new pod under the same name.
    Restarted,
    Retry,
}

/// Decides from the pod as it is now. `failure` is why the stream ended, when it did not
/// end cleanly.
pub(super) fn decide(
    pod: &Value,
    container: &str,
    seen: &mut Seen,
    failure: Option<&IpcError>,
) -> Decision {
    if let Some(error) = failure {
        if matches!(error.code, ErrorCode::Unauthorized | ErrorCode::Forbidden) {
            return Decision::Fail(error.clone());
        }
    }
    if !declares(pod, container) {
        return Decision::Fail(failure.cloned().unwrap_or_else(|| {
            IpcError::new(
                ErrorCode::NotFound,
                format!("the pod has no container {container}"),
            )
        }));
    }
    // A first read that failed left nothing to compare with, so this shows no change.
    if seen.uid.is_none() {
        *seen = Seen::of(pod, container);
    }
    let now = Seen::of(pod, container);
    if now.uid != seen.uid || now.restarts > seen.restarts {
        *seen = now;
        return Decision::Restarted;
    }
    if finished_for_good(pod, container) {
        return Decision::Done;
    }
    Decision::Retry
}

enum PumpEnd {
    Stopped,
    Ended,
    Failed(IpcError),
}

fn log_params(
    container: &str,
    options: &LogOptions,
    follow: bool,
    resume: Option<Timestamp>,
) -> LogParams {
    let mut params = LogParams {
        container: Some(container.to_owned()),
        follow,
        previous: options.previous,
        timestamps: true,
        ..LogParams::default()
    };
    match resume {
        // A resume wants everything since, however little the first request asked for.
        Some(last) => params.since_time = Some(last),
        None => {
            params.tail_lines = options.tail_lines.map(i64::from);
            params.since_seconds = options.since_seconds.map(i64::from);
        }
    }
    params
}

/// Sends one line unless the replay after a resume has sent it already. Returns false once nobody takes lines.
async fn deliver(
    context: &StreamContext,
    target: &StreamTarget,
    raw: &RawLine,
    progress: &mut Progress,
) -> bool {
    let line: LogLine = parse_line(raw, &target.pod, &target.container);
    let stamp = line
        .timestamp
        .as_deref()
        .and_then(|text| text.parse::<Timestamp>().ok());
    if let Some(stamp) = stamp {
        if let Some((boundary, skip)) = progress.replay.as_mut() {
            if stamp < *boundary {
                return true;
            }
            if stamp == *boundary && *skip > 0 {
                *skip -= 1;
                return true;
            }
            progress.replay = None;
        }
        if progress.last == Some(stamp) {
            progress.at_last += 1;
        } else {
            progress.last = Some(stamp);
            progress.at_last = 1;
        }
    }
    progress.fresh = true;
    if std::mem::take(&mut progress.reconnecting) {
        context.marker(target, LogMarker::Reconnected, None).await;
    }
    context.items.send(StreamItem::Line(line)).await.is_ok()
}

/// Opens one stream and copies its lines until it ends.
async fn pump(
    context: &StreamContext,
    target: &StreamTarget,
    params: &LogParams,
    progress: &mut Progress,
) -> PumpEnd {
    let pods: Api<Pod> = Api::namespaced(context.client.clone(), &context.namespace);
    let opened = tokio::select! {
        () = context.token.cancelled() => return PumpEnd::Stopped,
        opened = pods.log_stream(&target.pod, params) => opened,
    };
    let reader = match opened {
        Ok(reader) => reader,
        Err(error) => return PumpEnd::Failed(error.into()),
    };
    progress.opened = true;
    futures::pin_mut!(reader);
    let settled = tokio::time::sleep(SETTLE);
    tokio::pin!(settled);
    let mut splitter = LineSplitter::default();
    let mut chunk = vec![0; READ_CHUNK];
    loop {
        let read = tokio::select! {
            () = context.token.cancelled() => return PumpEnd::Stopped,
            () = &mut settled, if progress.reconnecting => {
                progress.reconnecting = false;
                context.marker(target, LogMarker::Reconnected, None).await;
                continue;
            }
            read = reader.read(&mut chunk) => read,
        };
        match read {
            Ok(0) => {
                if let Some(raw) = splitter.finish() {
                    if !deliver(context, target, &raw, progress).await {
                        return PumpEnd::Stopped;
                    }
                }
                return PumpEnd::Ended;
            }
            Ok(count) => {
                for raw in splitter.push(&chunk[..count]) {
                    if !deliver(context, target, &raw, progress).await {
                        return PumpEnd::Stopped;
                    }
                }
            }
            // What is left of the line comes again after the resume, so it is not sent.
            Err(error) => return PumpEnd::Failed(error.into()),
        }
    }
}

/// Reads the pod to decide what a stream's end means. Only an answer that the pod is
/// gone or out of reach for good ends the stream.
async fn after_stream(
    context: &StreamContext,
    target: &StreamTarget,
    seen: &mut Seen,
    failure: Option<&IpcError>,
) -> Result<Decision, ContainerEnd> {
    match read_pod(&context.client, &context.namespace, &target.pod).await {
        Ok(pod) => Ok(decide(&pod, &target.container, seen, failure)),
        Err(kube::Error::Api(status)) if status.code == 404 => Err(ContainerEnd::PodGone),
        Err(kube::Error::Api(status)) if matches!(status.code, 401 | 403) => {
            Err(ContainerEnd::Failed(kube::Error::Api(status).into()))
        }
        Err(_) => Ok(Decision::Retry),
    }
}

/// Follows one container until it ends for good or the session stops.
pub(super) async fn stream_container(context: StreamContext, target: StreamTarget) -> ContainerEnd {
    // Previous logs are finished by nature, whatever `follow` says.
    let follow = context.options.follow && !context.options.previous;
    let mut progress = Progress::default();
    let mut seen = if follow {
        read_pod(&context.client, &context.namespace, &target.pod)
            .await
            .map_or_else(|_| Seen::default(), |pod| Seen::of(&pod, &target.container))
    } else {
        Seen::default()
    };
    let mut backoff = MIN_BACKOFF;
    loop {
        progress.replay = progress.last.map(|last| (last, progress.at_last));
        let params = log_params(&target.container, &context.options, follow, progress.last);
        let failure = match pump(&context, &target, &params, &mut progress).await {
            PumpEnd::Stopped => return ContainerEnd::Stopped,
            PumpEnd::Ended => None,
            PumpEnd::Failed(error) => Some(error),
        };
        if !follow {
            return failure.map_or(ContainerEnd::Completed, ContainerEnd::Failed);
        }
        if std::mem::take(&mut progress.fresh) {
            backoff = MIN_BACKOFF;
        }
        let decision = match after_stream(&context, &target, &mut seen, failure.as_ref()).await {
            Ok(decision) => decision,
            Err(end) => return end,
        };
        match decision {
            Decision::Done => return ContainerEnd::Completed,
            Decision::Fail(error) => return ContainerEnd::Failed(error),
            Decision::Restarted => {
                context.marker(&target, LogMarker::Restarted, None).await;
                continue;
            }
            Decision::Retry => {}
        }
        if progress.opened && !progress.reconnecting {
            progress.reconnecting = true;
            let message = failure.map(|error| error.message);
            context
                .marker(&target, LogMarker::Reconnecting, message)
                .await;
        }
        let pause = backoff;
        backoff = (backoff * 2).min(MAX_BACKOFF);
        tokio::select! {
            () = context.token.cancelled() => return ContainerEnd::Stopped,
            () = tokio::time::sleep(pause) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn pod(status: Value) -> Value {
        json!({
            "metadata": { "uid": "u1" },
            "spec": {
                "restartPolicy": "Always",
                "containers": [{ "name": "main" }],
                "initContainers": [
                    { "name": "setup" },
                    { "name": "sidecar", "restartPolicy": "Always" },
                ],
            },
            "status": status,
        })
    }

    fn with_policy(mut object: Value, policy: &str) -> Value {
        object["spec"]["restartPolicy"] = json!(policy);
        object
    }

    fn terminated(name: &str, code: i32) -> Value {
        json!({ "name": name, "restartCount": 0, "state": { "terminated": { "exitCode": code } } })
    }

    fn seen_at_start() -> Seen {
        Seen {
            uid: Some("u1".into()),
            restarts: 0,
        }
    }

    #[test]
    fn a_running_container_is_retried() {
        let object = pod(json!({ "containerStatuses": [
            { "name": "main", "restartCount": 0, "state": { "running": {} } },
        ] }));
        let decision = decide(&object, "main", &mut seen_at_start(), None);
        assert_eq!(decision, Decision::Retry);
    }

    #[test]
    fn a_higher_restart_count_is_a_restart_and_is_remembered() {
        let object = pod(json!({ "containerStatuses": [
            { "name": "main", "restartCount": 2, "state": { "running": {} } },
        ] }));
        let mut seen = seen_at_start();
        assert_eq!(
            decide(&object, "main", &mut seen, None),
            Decision::Restarted
        );
        assert_eq!(decide(&object, "main", &mut seen, None), Decision::Retry);
    }

    #[test]
    fn a_first_look_after_a_failed_read_is_no_change() {
        let object = pod(json!({ "containerStatuses": [
            { "name": "main", "restartCount": 2, "state": { "running": {} } },
        ] }));
        let mut seen = Seen::default();
        assert_eq!(decide(&object, "main", &mut seen, None), Decision::Retry);
        assert_eq!(seen, Seen::of(&object, "main"));
    }

    #[test]
    fn a_new_uid_is_a_replacement() {
        let mut object = pod(json!({}));
        object["metadata"]["uid"] = json!("u2");
        assert_eq!(
            decide(&object, "main", &mut seen_at_start(), None),
            Decision::Restarted
        );
    }

    #[test]
    fn a_terminated_container_is_done_only_if_it_will_not_restart() {
        let failed = json!({ "containerStatuses": [terminated("main", 1)] });
        let done = |policy: &str, status: &Value| {
            decide(
                &with_policy(pod(status.clone()), policy),
                "main",
                &mut seen_at_start(),
                None,
            ) == Decision::Done
        };
        assert!(!done("Always", &failed));
        assert!(!done("OnFailure", &failed));
        assert!(done("Never", &failed));
        let succeeded = json!({ "containerStatuses": [terminated("main", 0)] });
        assert!(done("OnFailure", &succeeded));
    }

    #[test]
    fn a_finished_pod_is_done() {
        for phase in ["Succeeded", "Failed"] {
            let object = pod(json!({ "phase": phase }));
            assert_eq!(
                decide(&object, "main", &mut seen_at_start(), None),
                Decision::Done
            );
        }
    }

    #[test]
    fn an_init_container_that_succeeded_is_done_but_a_sidecar_is_not() {
        let status = json!({ "initContainerStatuses": [
            terminated("setup", 0), terminated("sidecar", 0),
        ] });
        let object = pod(status);
        assert_eq!(
            decide(&object, "setup", &mut seen_at_start(), None),
            Decision::Done
        );
        assert_eq!(
            decide(&object, "sidecar", &mut seen_at_start(), None),
            Decision::Retry
        );
    }

    #[test]
    fn forbidden_is_final_and_keeps_the_api_server_message() {
        let forbidden = IpcError::new(ErrorCode::Forbidden, "pods/log is forbidden");
        let decision = decide(
            &pod(json!({})),
            "main",
            &mut seen_at_start(),
            Some(&forbidden),
        );
        assert_eq!(decision, Decision::Fail(forbidden));
    }

    #[test]
    fn a_waiting_container_is_retried_but_an_undeclared_one_fails() {
        let waiting = IpcError::new(ErrorCode::Internal, "container is waiting to start");
        assert_eq!(
            decide(
                &pod(json!({})),
                "main",
                &mut seen_at_start(),
                Some(&waiting)
            ),
            Decision::Retry
        );
        let invalid = IpcError::new(ErrorCode::Internal, "container other is not valid");
        assert_eq!(
            decide(
                &pod(json!({})),
                "other",
                &mut seen_at_start(),
                Some(&invalid)
            ),
            Decision::Fail(invalid)
        );
    }

    fn options() -> LogOptions {
        LogOptions {
            follow: true,
            previous: false,
            tail_lines: Some(1000),
            since_seconds: Some(60),
        }
    }

    #[test]
    fn the_first_request_uses_the_options_and_a_resume_uses_the_time() {
        let first = log_params("c", &options(), true, None);
        assert_eq!(first.tail_lines, Some(1000));
        assert_eq!(first.since_seconds, Some(60));
        assert!(first.timestamps && first.follow);

        let last: Timestamp = "2026-01-01T00:00:01.5Z".parse().unwrap();
        let resume = log_params("c", &options(), true, Some(last));
        assert_eq!(resume.tail_lines, None);
        assert_eq!(resume.since_seconds, None);
        assert_eq!(resume.since_time, Some(last));
    }
}
