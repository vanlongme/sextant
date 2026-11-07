//! Long-running sessions: log streams, terminals and shells. The registry holds what
//! a stop needs, so that every stop rule ends a session the same way: its token is
//! cancelled, its task cleans up, and dropping its `SessionGuard` removes the entry.

mod exec;
mod flow;
mod logs;
mod node_shell;
mod pty;

use std::hash::{BuildHasher, Hasher, RandomState};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use dashmap::DashMap;
use k8s_openapi::api::core::v1::Pod;
use kube::api::GetParams;
use kube::core::{Request, Resource};
use kube::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{mpsc, watch, Notify};
use tokio_util::sync::CancellationToken;
use ts_rs::TS;

use crate::app_core::AppCore;
use crate::error::{CoreResult, ErrorCode, IpcError};

pub(crate) use flow::FlowControl;
pub use logs::{LogDownload, LogEndReason, LogEvent, LogLine, LogMarker, LogOptions, LogTarget};

/// The size of a terminal, in character cells.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSize {
    pub cols: u16,
    pub rows: u16,
}

/// What a terminal session reports, apart from its output.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SessionEvent {
    /// Progress before the session starts, such as a node shell pod starting.
    Status { message: String },
    /// With `tty: false` the session is output only.
    Started { tty: bool },
    /// `code` is `None` when the session was stopped or the code is unknown.
    Exited { code: Option<u32> },
    Failed {
        error: IpcError,
        #[serde(rename = "podEvents")]
        pod_events: Vec<String>,
    },
}

/// One channel for output and events, so an exit cannot overtake the output before it.
#[derive(Debug, Clone)]
pub enum SessionOutput {
    Data(Vec<u8>),
    Event(SessionEvent),
}

/// How a running terminal session is driven. A session with no `input` is output only.
#[derive(Debug)]
pub(crate) struct TerminalControl {
    pub(crate) input: Option<mpsc::Sender<Vec<u8>>>,
    pub(crate) resize: watch::Sender<TerminalSize>,
    pub(crate) flow: Arc<FlowControl>,
}

#[derive(Debug)]
struct RunningSession {
    token: CancellationToken,
    /// `None` for a log stream.
    control: Option<TerminalControl>,
}

#[derive(Debug, Default)]
pub(crate) struct SessionRegistry {
    sessions: DashMap<String, RunningSession>,
    next: AtomicU64,
    ended: Notify,
    /// Milliseconds, set by tests. Zero means the real limit.
    node_shell_limit_ms: AtomicU64,
}

impl SessionRegistry {
    /// Adds a session. It stays listed until the guard is dropped.
    pub(crate) fn register(
        self: &Arc<Self>,
        token: CancellationToken,
        control: Option<TerminalControl>,
    ) -> SessionGuard {
        let number = self.next.fetch_add(1, Ordering::Relaxed);
        let id = format!("session-{number}");
        self.sessions
            .insert(id.clone(), RunningSession { token, control });
        SessionGuard {
            registry: self.clone(),
            id,
        }
    }

    pub(crate) fn node_shell_limit(&self) -> Duration {
        match self.node_shell_limit_ms.load(Ordering::Relaxed) {
            0 => node_shell::START_LIMIT,
            millis => Duration::from_millis(millis),
        }
    }

    pub(crate) fn set_node_shell_limit(&self, limit: Duration) {
        let millis = u64::try_from(limit.as_millis()).unwrap_or(u64::MAX);
        self.node_shell_limit_ms.store(millis, Ordering::Relaxed);
    }

    fn stop(&self, id: &str) {
        if let Some(session) = self.sessions.get(id) {
            session.token.cancel();
        }
    }

    fn stop_all(&self) {
        for session in self.sessions.iter() {
            session.token.cancel();
        }
    }

    fn len(&self) -> usize {
        self.sessions.len()
    }

    /// Waits until no session is listed, or for `limit`. Returns whether none is.
    async fn wait_idle(&self, limit: Duration) -> bool {
        let idle = async {
            loop {
                let ended = self.ended.notified();
                tokio::pin!(ended);
                ended.as_mut().enable();
                if self.sessions.is_empty() {
                    return;
                }
                ended.await;
            }
        };
        tokio::time::timeout(limit, idle).await.is_ok()
    }
}

/// Sixteen hex digits that differ from one call to the next, for names that must not collide.
pub(crate) fn random_hex() -> String {
    format!("{:016x}", RandomState::new().build_hasher().finish())
}

/// One pod as plain JSON, so a pod with little in it still reads.
pub(crate) async fn read_pod(
    client: &Client,
    namespace: &str,
    name: &str,
) -> Result<Value, kube::Error> {
    let request = Request::new(Pod::url_path(&(), Some(namespace)))
        .get(name, &GetParams::default())
        .map_err(kube::Error::BuildRequest)?;
    client.request(request).await
}

/// The containers a pod declares, init containers first, as they run.
pub(crate) fn pod_container_names(pod: &Value) -> Vec<String> {
    ["/spec/initContainers", "/spec/containers"]
        .iter()
        .filter_map(|pointer| pod.pointer(pointer).and_then(Value::as_array))
        .flatten()
        .filter_map(|container| container.get("name").and_then(Value::as_str))
        .map(str::to_owned)
        .collect()
}

/// Held by a session's task. Dropping it marks the session as gone, panic included, so
/// it must outlive the session's cleanup.
#[derive(Debug)]
pub(crate) struct SessionGuard {
    registry: Arc<SessionRegistry>,
    id: String,
}

impl SessionGuard {
    pub(crate) fn id(&self) -> &str {
        &self.id
    }
}

impl Drop for SessionGuard {
    fn drop(&mut self) {
        self.registry.sessions.remove(&self.id);
        self.registry.ended.notify_waiters();
    }
}

impl AppCore {
    /// Stops one session. An id that is not running is ignored, so it is safe to repeat.
    pub fn session_stop(&self, id: &str) {
        self.sessions().stop(id);
    }

    /// Stops every session on every cluster, for when the page that started them goes
    /// away. It took their ids with it, and a Tauri channel can still be written after a
    /// reload, so nothing else would stop them. Port-forwards are not sessions: the new
    /// page finds them with `portforward_list`.
    pub fn sessions_stop_all(&self) {
        self.sessions().stop_all();
    }

    /// How many sessions are running, node shell cleanup included.
    pub fn session_count(&self) -> usize {
        self.sessions().len()
    }

    /// Waits until every session has cleaned up, or for `limit`. Returns whether all have.
    pub async fn sessions_wait_idle(&self, limit: Duration) -> bool {
        self.sessions().wait_idle(limit).await
    }

    /// Queues input for a terminal session. It never waits, so a process that stopped
    /// reading gets an error instead of blocking the caller.
    pub fn session_write(&self, id: &str, data: Vec<u8>) -> CoreResult<()> {
        let session = self
            .sessions()
            .sessions
            .get(id)
            .ok_or_else(|| IpcError::new(ErrorCode::NotFound, format!("no session {id}")))?;
        let input = session
            .control
            .as_ref()
            .and_then(|control| control.input.as_ref())
            .ok_or_else(|| IpcError::new(ErrorCode::InvalidInput, "this session takes no input"))?;
        input.try_send(data).map_err(|error| match error {
            mpsc::error::TrySendError::Full(_) => {
                IpcError::new(ErrorCode::Conflict, "the terminal is not reading its input")
            }
            mpsc::error::TrySendError::Closed(_) => {
                IpcError::new(ErrorCode::NotFound, format!("session {id} has ended"))
            }
        })
    }

    /// Resizes a terminal session. A late call, after the session ended, is ignored.
    pub fn session_resize(&self, id: &str, size: TerminalSize) {
        if let Some(session) = self.sessions().sessions.get(id) {
            if let Some(control) = &session.control {
                control.resize.send_replace(size);
            }
        }
    }

    /// Records that the interface has written `bytes` of output. A late call, after the
    /// session ended, is ignored.
    pub fn session_ack(&self, id: &str, bytes: u64) {
        if let Some(session) = self.sessions().sessions.get(id) {
            if let Some(control) = &session.control {
                control.flow.acked(bytes);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn control() -> (TerminalControl, mpsc::Receiver<Vec<u8>>) {
        let (input, input_rx) = mpsc::channel(2);
        let (resize, _) = watch::channel(TerminalSize { cols: 80, rows: 24 });
        let control = TerminalControl {
            input: Some(input),
            resize,
            flow: Arc::new(FlowControl::new()),
        };
        (control, input_rx)
    }

    #[test]
    fn ids_are_unique() {
        let registry = Arc::new(SessionRegistry::default());
        let first = registry.register(CancellationToken::new(), None);
        let second = registry.register(CancellationToken::new(), None);
        assert_ne!(first.id(), second.id());
        assert_eq!(registry.len(), 2);
    }

    #[test]
    fn dropping_the_guard_removes_the_session() {
        let registry = Arc::new(SessionRegistry::default());
        let guard = registry.register(CancellationToken::new(), None);
        drop(guard);
        assert_eq!(registry.len(), 0);
    }

    #[test]
    fn stop_cancels_that_session_only_and_can_be_repeated() {
        let registry = Arc::new(SessionRegistry::default());
        let (a, b) = (CancellationToken::new(), CancellationToken::new());
        let guard_a = registry.register(a.clone(), None);
        let _guard_b = registry.register(b.clone(), None);
        registry.stop(guard_a.id());
        registry.stop(guard_a.id());
        registry.stop("session-unknown");
        assert!(a.is_cancelled());
        assert!(!b.is_cancelled());
    }

    #[test]
    fn stop_all_cancels_every_session() {
        let registry = Arc::new(SessionRegistry::default());
        let (a, b) = (CancellationToken::new(), CancellationToken::new());
        let _guard_a = registry.register(a.clone(), None);
        let _guard_b = registry.register(b.clone(), None);
        registry.stop_all();
        assert!(a.is_cancelled() && b.is_cancelled());
    }

    #[tokio::test]
    async fn wait_idle_ends_when_the_last_session_ends() {
        let registry = Arc::new(SessionRegistry::default());
        let guard = registry.register(CancellationToken::new(), None);
        let waiter = {
            let registry = registry.clone();
            tokio::spawn(async move { registry.wait_idle(Duration::from_secs(30)).await })
        };
        tokio::task::yield_now().await;
        drop(guard);
        assert!(waiter.await.unwrap());
    }

    #[tokio::test]
    async fn wait_idle_gives_up_at_its_limit() {
        let registry = Arc::new(SessionRegistry::default());
        let _guard = registry.register(CancellationToken::new(), None);
        assert!(!registry.wait_idle(Duration::from_millis(20)).await);
    }

    async fn started_core() -> (AppCore, tempfile::TempDir) {
        let root = tempfile::tempdir().unwrap();
        let paths =
            crate::paths::AppPaths::under(&root.path().join("app"), &root.path().join("home"));
        let core = AppCore::start_with_kubeconfig_env(paths, None)
            .await
            .unwrap();
        (core, root)
    }

    #[tokio::test]
    async fn stopping_all_through_the_core_cancels_and_waits() {
        // `on_page_load` in `sextant-app` has no automated coverage. This is the method it calls.
        let (core, _root) = started_core().await;
        let token = CancellationToken::new();
        let guard = core.sessions().register(token.clone(), None);
        assert_eq!(core.session_count(), 1);
        core.sessions_stop_all();
        assert!(token.is_cancelled());
        assert!(!core.sessions_wait_idle(Duration::from_millis(20)).await);
        drop(guard);
        assert!(core.sessions_wait_idle(Duration::from_secs(5)).await);
        assert_eq!(core.session_count(), 0);
    }

    #[tokio::test]
    async fn shutdown_waits_for_a_session_to_clean_up() {
        let (core, _root) = started_core().await;
        let token = CancellationToken::new();
        let guard = core.sessions().register(token.clone(), None);
        let cleaned = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = cleaned.clone();
        tokio::spawn(async move {
            token.cancelled().await;
            tokio::time::sleep(Duration::from_millis(50)).await;
            flag.store(true, Ordering::SeqCst);
            drop(guard);
        });
        core.shutdown().await;
        assert!(cleaned.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn write_reports_what_stopped_the_input() {
        let (core, _root) = started_core().await;
        let missing = core.session_write("session-unknown", vec![1]).unwrap_err();
        assert_eq!(missing.code, ErrorCode::NotFound);

        let log_stream = core.sessions().register(CancellationToken::new(), None);
        let no_input = core.session_write(log_stream.id(), vec![1]).unwrap_err();
        assert_eq!(no_input.code, ErrorCode::InvalidInput);

        let (control, input) = control();
        let terminal = core
            .sessions()
            .register(CancellationToken::new(), Some(control));
        core.session_write(terminal.id(), vec![1]).unwrap();
        core.session_write(terminal.id(), vec![2]).unwrap();
        let full = core.session_write(terminal.id(), vec![3]).unwrap_err();
        assert_eq!(full.code, ErrorCode::Conflict);
        drop(input);
        let closed = core.session_write(terminal.id(), vec![4]).unwrap_err();
        assert_eq!(closed.code, ErrorCode::NotFound);
    }

    #[tokio::test]
    async fn late_calls_on_a_finished_session_are_ignored() {
        let (core, _root) = started_core().await;
        core.session_ack("session-unknown", 10);
        core.session_resize("session-unknown", TerminalSize { cols: 1, rows: 1 });
        core.session_stop("session-unknown");
    }

    #[test]
    fn events_serialize_as_the_contract_says() {
        let failed = SessionEvent::Failed {
            error: IpcError::new(ErrorCode::NotFound, "gone"),
            pod_events: vec!["FailedScheduling: no nodes".to_owned()],
        };
        let value = serde_json::to_value(&failed).unwrap();
        assert_eq!(value["type"], "failed");
        assert_eq!(value["podEvents"][0], "FailedScheduling: no nodes");
        assert_eq!(value["error"]["code"], "NotFound");
        let exited = serde_json::to_value(SessionEvent::Exited { code: None }).unwrap();
        assert_eq!(
            exited,
            serde_json::json!({ "type": "exited", "code": null })
        );
    }

    #[test]
    fn terminal_control_is_reached_through_the_registry() {
        let registry = Arc::new(SessionRegistry::default());
        let (control, _input) = control();
        let flow = control.flow.clone();
        let guard = registry.register(CancellationToken::new(), Some(control));
        flow.sent(100);
        let session = registry.sessions.get(guard.id()).unwrap();
        session.control.as_ref().unwrap().flow.acked(100);
        assert_eq!(flow.unacked(), 0);
    }
}
