//! Log streaming (F10). `parse` turns bytes into lines, `follow` keeps one container's
//! stream going, and this file runs a session: one task per stream, feeding one batcher.

mod download;
mod follow;
mod parse;
mod workload;

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;
use ts_rs::TS;

use super::{pod_container_names, read_pod, FlowControl};
use crate::app_core::AppCore;
use crate::error::{CoreResult, IpcError};
use crate::kubeconfig::ClusterId;
use crate::resources::{invalid, is_path_segment, ResourceRef};
use follow::{stream_container, ContainerEnd, StreamContext, StreamTarget};

/// Lines wait this long at most before they are sent.
const FLUSH_EVERY: Duration = Duration::from_millis(100);
/// One flush carries at most this many lines. Reading waits for the next flush once it
/// is reached.
const FLUSH_LINES: usize = 5_000;
/// One flush stops growing at this many bytes, so its last line can pass it. Lines can be
/// long, so a limit on their number alone would not limit the memory they take.
const FLUSH_BYTES: u64 = 1024 * 1024;
/// Lines on their way to the batcher, across all of a session's streams.
const ITEM_BACKLOG: usize = 256;

/// Which logs a session reads.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LogTarget {
    /// `container: None` means every container, init containers included.
    Pod {
        namespace: String,
        pod: String,
        container: Option<String>,
    },
    /// Deployments, StatefulSets, DaemonSets, ReplicaSets and Jobs.
    Workload {
        resource: ResourceRef,
        namespace: String,
        name: String,
        container: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct LogOptions {
    pub follow: bool,
    pub previous: bool,
    /// `None` means no limit. The interface sends the default of F10.
    pub tail_lines: Option<u32>,
    pub since_seconds: Option<u32>,
}

/// One line of a container's log.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub pod: String,
    pub container: String,
    /// Always requested, so the view's toggle restarts nothing.
    pub timestamp: Option<String>,
    /// ANSI codes included.
    pub text: String,
    /// The line passed 64 KiB.
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum LogMarker {
    Restarted,
    Reconnecting,
    Reconnected,
    PodAdded,
    PodRemoved,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum LogEndReason {
    Completed,
    PodGone,
    Stopped,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LogEvent {
    Lines {
        lines: Vec<LogLine>,
        /// What to pass to `session_ack` once the lines are stored.
        #[ts(type = "number")]
        bytes: u64,
    },
    Marker {
        pod: String,
        container: Option<String>,
        marker: LogMarker,
        message: Option<String>,
    },
    Ended {
        reason: LogEndReason,
    },
    Failed {
        error: IpcError,
    },
}

/// What `logs_download` wrote.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct LogDownload {
    #[ts(type = "number")]
    pub bytes: u64,
}

/// What a stream hands to the batcher. Both kinds share one queue, so a marker stays
/// between the lines it came between.
#[derive(Debug)]
enum StreamItem {
    Line(LogLine),
    Marker {
        pod: String,
        container: Option<String>,
        marker: LogMarker,
        message: Option<String>,
    },
}

fn line_bytes(line: &LogLine) -> u64 {
    let timestamp = line.timestamp.as_ref().map_or(0, String::len);
    (line.pod.len() + line.container.len() + timestamp + line.text.len()) as u64
}

/// The lines waiting for the next flush.
#[derive(Debug, Default)]
struct Batch {
    lines: Vec<LogLine>,
    bytes: u64,
}

impl Batch {
    fn has_room(&self) -> bool {
        self.lines.len() < FLUSH_LINES && self.bytes < FLUSH_BYTES
    }

    fn push(&mut self, line: LogLine) {
        self.bytes += line_bytes(&line);
        self.lines.push(line);
    }
}

async fn flush(batch: &mut Batch, events: &mpsc::Sender<LogEvent>, flow: &FlowControl) -> bool {
    if batch.lines.is_empty() {
        return true;
    }
    let Batch { lines, bytes } = std::mem::take(batch);
    // Before the send, because the acknowledgement can arrive as soon as it is made.
    flow.sent(bytes);
    events.send(LogEvent::Lines { lines, bytes }).await.is_ok()
}

/// Turns stream items into events until every stream has ended. A failed send means nobody
/// is listening, which stops the session.
///
/// A Tauri channel does not wait for the webview, so `flow` is what paces a flood: once too
/// much is unacknowledged nothing is read from `items`, which backs up into the API server
/// stream. The batch is empty by then, because only a flush can start that wait.
async fn run_batcher(
    mut items: mpsc::Receiver<StreamItem>,
    events: mpsc::Sender<LogEvent>,
    flow: Arc<FlowControl>,
    token: CancellationToken,
) {
    let mut batch = Batch::default();
    let mut tick = tokio::time::interval(FLUSH_EVERY);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let delivered = loop {
        // A stream may be waiting on `items`, so stopping has to end this wait or it could
        // never see the token, and the batcher ends only after the last stream.
        tokio::select! {
            () = flow.ready() => {}
            () = token.cancelled() => flow.release(),
        }
        tokio::select! {
            item = items.recv(), if batch.has_room() => match item {
                Some(StreamItem::Line(line)) => batch.push(line),
                Some(StreamItem::Marker { pod, container, marker, message }) => {
                    let event = LogEvent::Marker { pod, container, marker, message };
                    if !flush(&mut batch, &events, &flow).await
                        || events.send(event).await.is_err()
                    {
                        break false;
                    }
                }
                None => break flush(&mut batch, &events, &flow).await,
            },
            _ = tick.tick() => {
                if !flush(&mut batch, &events, &flow).await {
                    break false;
                }
            }
        }
    };
    if !delivered {
        token.cancel();
    }
}

fn check_name(value: &str, what: &str) -> CoreResult<()> {
    if is_path_segment(value) {
        Ok(())
    } else {
        Err(invalid(format!("the {what} is not valid")))
    }
}

fn check_target(target: &LogTarget) -> CoreResult<()> {
    let (namespace, name, container) = match target {
        LogTarget::Pod {
            namespace,
            pod,
            container,
        } => (namespace, pod, container),
        LogTarget::Workload {
            resource,
            namespace,
            name,
            container,
        } => {
            if !workload::is_workload(resource) {
                return Err(invalid(format!(
                    "logs are not available for {}",
                    resource.plural
                )));
            }
            check_name(&resource.version, "resource version")?;
            (namespace, name, container)
        }
    };
    check_name(namespace, "namespace")?;
    check_name(name, "name")?;
    container
        .as_deref()
        .map_or(Ok(()), |container| check_name(container, "container name"))
}

/// The session's last event, from how its streams ended.
fn pod_session_end(ends: Vec<ContainerEnd>, stopped: bool) -> LogEvent {
    if stopped {
        return LogEvent::Ended {
            reason: LogEndReason::Stopped,
        };
    }
    if ends.iter().any(|end| matches!(end, ContainerEnd::PodGone)) {
        return LogEvent::Ended {
            reason: LogEndReason::PodGone,
        };
    }
    let any_completed = ends
        .iter()
        .any(|end| matches!(end, ContainerEnd::Completed));
    let first_failure = ends.into_iter().find_map(|end| match end {
        ContainerEnd::Failed(error) => Some(error),
        _ => None,
    });
    match first_failure {
        Some(error) if !any_completed => LogEvent::Failed { error },
        _ => LogEvent::Ended {
            reason: LogEndReason::Completed,
        },
    }
}

/// Runs one stream per target until all have ended, and returns the session's last event.
async fn run_streams(context: StreamContext, targets: Vec<StreamTarget>) -> LogEvent {
    let several = targets.len() > 1;
    let mut streams = JoinSet::new();
    for target in targets {
        let context = context.clone();
        streams.spawn(async move { (target.clone(), stream_container(context, target).await) });
    }
    let mut ends = Vec::new();
    while let Some(joined) = streams.join_next().await {
        let Ok((target, end)) = joined else {
            continue;
        };
        // Alone, a failure ends the session, and its last event says so.
        if let (true, ContainerEnd::Failed(error)) = (several, &end) {
            context
                .marker(&target, LogMarker::Failed, Some(error.message.clone()))
                .await;
        }
        ends.push(end);
    }
    pod_session_end(ends, context.token.is_cancelled())
}

async fn run_pod_target(
    context: StreamContext,
    namespace: &str,
    pod: &str,
    container: Option<String>,
) -> LogEvent {
    let object: Value = match read_pod(&context.client, namespace, pod).await {
        Ok(object) => object,
        Err(error) => {
            return LogEvent::Failed {
                error: error.into(),
            }
        }
    };
    let containers = container.map_or_else(|| pod_container_names(&object), |name| vec![name]);
    let targets = containers
        .into_iter()
        .map(|container| StreamTarget {
            pod: pod.to_owned(),
            container,
        })
        .collect();
    run_streams(context, targets).await
}

async fn run_target(context: StreamContext, target: LogTarget) -> LogEvent {
    match target {
        LogTarget::Pod {
            namespace,
            pod,
            container,
        } => run_pod_target(context, &namespace, &pod, container).await,
        LogTarget::Workload {
            resource,
            name,
            container,
            ..
        } => workload::run_workload_target(context, resource, name, container).await,
    }
}

impl AppCore {
    /// Starts a log session and returns its id. Events go to `events`, the last being
    /// `Ended` or `Failed`. Only bad arguments and a cluster that is not connected are
    /// errors here. Anything found later arrives as an event.
    pub fn logs_start(
        &self,
        id: &ClusterId,
        target: LogTarget,
        options: LogOptions,
        events: mpsc::Sender<LogEvent>,
    ) -> CoreResult<String> {
        check_target(&target)?;
        let client = self.cluster_client(id)?;
        let token = self.cluster_cancel_token(id)?;
        let flow = Arc::new(FlowControl::new());
        let guard = self.sessions().register_log(token.clone(), flow.clone());
        let session = guard.id().to_owned();
        tokio::spawn(async move {
            let (items, items_rx) = mpsc::channel(ITEM_BACKLOG);
            let batcher = tokio::spawn(run_batcher(items_rx, events.clone(), flow, token.clone()));
            let context = StreamContext {
                client,
                namespace: target_namespace(&target).to_owned(),
                options,
                items,
                token,
                follow_replacements: true,
            };
            // Each stream holds a clone of `items`, so the batcher ends after the last one.
            let last = run_target(context, target).await;
            if batcher.await.is_err() {
                tracing::warn!("a log batcher stopped unexpectedly");
            }
            let _ = events.send(last).await;
            drop(guard);
        });
        Ok(session)
    }

    /// Stops a log session. An id that is not running is ignored.
    pub fn logs_stop(&self, session: &str) {
        self.session_stop(session);
    }
}

fn target_namespace(target: &LogTarget) -> &str {
    match target {
        LogTarget::Pod { namespace, .. } | LogTarget::Workload { namespace, .. } => namespace,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;
    use crate::sessions::flow::PAUSE_AT;

    const LIMIT: Duration = Duration::from_secs(30);
    /// Several flushes long, so a batcher that is still reading would send something.
    const SILENCE: Duration = Duration::from_millis(500);
    const LONG_LINE: usize = 64 * 1024;

    fn failure() -> IpcError {
        IpcError::new(ErrorCode::Forbidden, "no")
    }

    fn long_line() -> StreamItem {
        StreamItem::Line(LogLine {
            pod: "p".into(),
            container: "c".into(),
            timestamp: None,
            text: "x".repeat(LONG_LINE),
            truncated: false,
        })
    }

    fn feed_long_lines(items: mpsc::Sender<StreamItem>, total: usize) {
        tokio::spawn(async move {
            for _ in 0..total {
                if items.send(long_line()).await.is_err() {
                    return;
                }
            }
        });
    }

    fn start_batcher(
        token: CancellationToken,
    ) -> (
        mpsc::Sender<StreamItem>,
        mpsc::Receiver<LogEvent>,
        Arc<FlowControl>,
        tokio::task::JoinHandle<()>,
    ) {
        let (items, items_rx) = mpsc::channel(ITEM_BACKLOG);
        let (events, events_rx) = mpsc::channel(4);
        let flow = Arc::new(FlowControl::new());
        let batcher = tokio::spawn(run_batcher(items_rx, events, flow.clone(), token));
        (items, events_rx, flow, batcher)
    }

    #[tokio::test]
    async fn a_batch_stops_at_the_byte_limit_and_reports_its_size() {
        let (items, mut events, flow, batcher) = start_batcher(CancellationToken::new());
        let total = 40;
        feed_long_lines(items, total);
        let mut seen = 0;
        while seen < total {
            let event = tokio::time::timeout(LIMIT, events.recv()).await.unwrap();
            let Some(LogEvent::Lines { lines, bytes }) = event else {
                panic!("the batcher ended early");
            };
            assert_eq!(bytes, lines.iter().map(line_bytes).sum::<u64>());
            assert!(
                bytes < FLUSH_BYTES + 2 * LONG_LINE as u64,
                "a batch of {bytes} bytes"
            );
            seen += lines.len();
            flow.acked(bytes);
        }
        batcher.await.unwrap();
    }

    #[tokio::test]
    async fn reading_waits_for_acknowledgements() {
        let (items, mut events, flow, batcher) = start_batcher(CancellationToken::new());
        let total = 100;
        feed_long_lines(items, total);

        let (mut seen, mut unacked) = (0, 0);
        while let Ok(Some(event)) = tokio::time::timeout(SILENCE, events.recv()).await {
            let LogEvent::Lines { lines, bytes } = event else {
                panic!("{event:?}");
            };
            seen += lines.len();
            unacked += bytes;
        }
        assert!(seen < total, "every line came with nothing acknowledged");
        assert!(unacked >= PAUSE_AT, "stopped early, at {unacked} bytes");
        assert!(
            unacked < PAUSE_AT + FLUSH_BYTES + 2 * LONG_LINE as u64,
            "stopped late, at {unacked} bytes"
        );

        flow.acked(unacked);
        while seen < total {
            let event = tokio::time::timeout(LIMIT, events.recv()).await.unwrap();
            let Some(LogEvent::Lines { lines, bytes }) = event else {
                panic!("the batcher ended early");
            };
            seen += lines.len();
            flow.acked(bytes);
        }
        batcher.await.unwrap();
    }

    #[tokio::test]
    async fn stopping_ends_a_batcher_nobody_acknowledges() {
        let token = CancellationToken::new();
        let (items, mut events, _flow, batcher) = start_batcher(token.clone());
        // Like a stream, it sends until it is stopped, and waits while nothing is read.
        let stream_token = token.clone();
        tokio::spawn(async move {
            while !stream_token.is_cancelled() {
                if items.send(long_line()).await.is_err() {
                    return;
                }
            }
        });
        tokio::time::timeout(LIMIT, async {
            while let Ok(Some(_)) = tokio::time::timeout(SILENCE, events.recv()).await {}
        })
        .await
        .expect("the batcher never stopped reading");

        token.cancel();
        tokio::time::timeout(LIMIT, async {
            while events.recv().await.is_some() {}
        })
        .await
        .expect("the batcher did not end");
        batcher.await.unwrap();
    }

    #[test]
    fn a_stopped_session_says_so_whatever_its_streams_did() {
        let last = pod_session_end(vec![ContainerEnd::Failed(failure())], true);
        assert!(matches!(
            last,
            LogEvent::Ended {
                reason: LogEndReason::Stopped
            }
        ));
    }

    #[test]
    fn a_failure_ends_the_session_only_when_nothing_else_worked() {
        let alone = pod_session_end(vec![ContainerEnd::Failed(failure())], false);
        assert!(matches!(alone, LogEvent::Failed { .. }));
        let beside_another = pod_session_end(
            vec![ContainerEnd::Failed(failure()), ContainerEnd::Completed],
            false,
        );
        assert!(matches!(
            beside_another,
            LogEvent::Ended {
                reason: LogEndReason::Completed
            }
        ));
    }

    #[test]
    fn a_gone_pod_wins_over_a_failure() {
        let last = pod_session_end(
            vec![ContainerEnd::Failed(failure()), ContainerEnd::PodGone],
            false,
        );
        assert!(matches!(
            last,
            LogEvent::Ended {
                reason: LogEndReason::PodGone
            }
        ));
    }

    #[tokio::test]
    async fn a_flood_flushes_at_most_the_limit_each_tick_and_in_order() {
        let (items, items_rx) = mpsc::channel(ITEM_BACKLOG);
        let (events, mut events_rx) = mpsc::channel(4);
        let flow = Arc::new(FlowControl::new());
        let batcher = tokio::spawn(run_batcher(
            items_rx,
            events,
            flow,
            CancellationToken::new(),
        ));
        let total = FLUSH_LINES * 2 + 10;
        tokio::spawn(async move {
            for number in 0..total {
                let line = LogLine {
                    pod: "p".into(),
                    container: "c".into(),
                    timestamp: None,
                    text: number.to_string(),
                    truncated: false,
                };
                if items.send(StreamItem::Line(line)).await.is_err() {
                    return;
                }
            }
        });
        let mut seen = 0;
        while seen < total {
            let Some(LogEvent::Lines { lines, .. }) = events_rx.recv().await else {
                panic!("the batcher ended early");
            };
            assert!(lines.len() <= FLUSH_LINES);
            for line in &lines {
                assert_eq!(line.text, seen.to_string());
                seen += 1;
            }
        }
        batcher.await.unwrap();
    }

    #[tokio::test]
    async fn a_marker_stays_between_the_lines_it_came_between() {
        let (items, items_rx) = mpsc::channel(ITEM_BACKLOG);
        let (events, mut events_rx) = mpsc::channel(4);
        let flow = Arc::new(FlowControl::new());
        let batcher = tokio::spawn(run_batcher(
            items_rx,
            events,
            flow,
            CancellationToken::new(),
        ));
        let line = |text: &str| {
            StreamItem::Line(LogLine {
                pod: "p".into(),
                container: "c".into(),
                timestamp: None,
                text: text.into(),
                truncated: false,
            })
        };
        items.send(line("before")).await.unwrap();
        items
            .send(StreamItem::Marker {
                pod: "p".into(),
                container: Some("c".into()),
                marker: LogMarker::Restarted,
                message: None,
            })
            .await
            .unwrap();
        items.send(line("after")).await.unwrap();
        drop(items);
        batcher.await.unwrap();
        let mut seen = Vec::new();
        while let Some(event) = events_rx.recv().await {
            seen.push(match event {
                LogEvent::Lines { lines, .. } => lines[0].text.clone(),
                LogEvent::Marker { marker, .. } => format!("{marker:?}"),
                other => panic!("{other:?}"),
            });
        }
        assert_eq!(seen, ["before", "Restarted", "after"]);
    }

    #[tokio::test]
    async fn nobody_listening_stops_the_session() {
        let (items, items_rx) = mpsc::channel(ITEM_BACKLOG);
        let (events, events_rx) = mpsc::channel(4);
        let token = CancellationToken::new();
        let flow = Arc::new(FlowControl::new());
        let batcher = tokio::spawn(run_batcher(items_rx, events, flow, token.clone()));
        drop(events_rx);
        items
            .send(StreamItem::Line(LogLine {
                pod: "p".into(),
                container: "c".into(),
                timestamp: None,
                text: "x".into(),
                truncated: false,
            }))
            .await
            .unwrap();
        batcher.await.unwrap();
        assert!(token.is_cancelled());
    }

    #[test]
    fn events_serialize_as_the_contract_says() {
        let lines = LogEvent::Lines {
            lines: Vec::new(),
            bytes: 7,
        };
        assert_eq!(
            serde_json::to_value(&lines).unwrap(),
            serde_json::json!({ "type": "lines", "lines": [], "bytes": 7 })
        );
        let marker = LogEvent::Marker {
            pod: "p".into(),
            container: None,
            marker: LogMarker::PodAdded,
            message: None,
        };
        assert_eq!(
            serde_json::to_value(&marker).unwrap(),
            serde_json::json!({
                "type": "marker", "pod": "p", "container": null,
                "marker": "podAdded", "message": null,
            })
        );
        let ended = LogEvent::Ended {
            reason: LogEndReason::PodGone,
        };
        assert_eq!(
            serde_json::to_value(&ended).unwrap(),
            serde_json::json!({ "type": "ended", "reason": "podGone" })
        );
    }

    #[test]
    fn a_target_with_a_bad_name_is_refused() {
        let bad = LogTarget::Pod {
            namespace: "default".into(),
            pod: "../etc".into(),
            container: None,
        };
        assert_eq!(
            check_target(&bad).unwrap_err().code,
            ErrorCode::InvalidInput
        );
    }
}
