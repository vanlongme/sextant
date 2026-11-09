//! One handle per cluster, holding its state, log and live connection.

use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use dashmap::DashMap;
use kube::{Client, Discovery};
use serde::Serialize;
use tokio::sync::{broadcast, watch};
use tokio_util::sync::CancellationToken;
use ts_rs::TS;

use super::connect::{
    establish, prepare_kubeconfig, run_discovery, ConnectTimeouts, Established, Failure,
};
use super::state::{ConnectionState, FailureKind};
use crate::app_core::CoreEvent;
use crate::error::{sanitize_text, CoreResult, ErrorCode, IpcError};
use crate::kubeconfig::{ClusterId, ContextEntry};
use crate::prefs::ClusterSettings;
use crate::resources::ApiResourceInfo;

const RUNTIME_DIR: &str = "runtime";
const LOG_CAPACITY: usize = 500;

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ConnectionLogEntry {
    #[ts(type = "number")]
    pub ts_ms: i64,
    pub level: LogLevel,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum LogLevel {
    Info,
    Warn,
    Error,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as i64)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn not_connected(id: &ClusterId) -> IpcError {
    IpcError::new(
        ErrorCode::Unreachable,
        format!("cluster {id} is not connected"),
    )
}

fn remove_kubeconfig(path: &Path) {
    if let Err(e) = std::fs::remove_file(path) {
        if e.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!("cannot delete {}: {e}", path.display());
        }
    }
}

/// Files left by a crash hold credentials. A failure here must not stop the app,
/// and writing the per-context file later reports its own errors.
fn reset_runtime_dir(dir: &Path) {
    if let Err(e) = std::fs::remove_dir_all(dir) {
        if e.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!("cannot clear {}: {e}", dir.display());
        }
    }
    if let Err(e) = create_private_dir(dir) {
        tracing::warn!("cannot create {}: {e}", dir.display());
    }
}

fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

struct Live {
    client: Client,
    discovery: Arc<Discovery>,
    /// Told apart from the connection that replaces this one, so a late result
    /// of the old one is not stored.
    epoch: u64,
    /// Dropped with the connection, so a reconnect starts without it.
    resources: Option<Arc<Vec<ApiResourceInfo>>>,
}

static NEXT_EPOCH: AtomicU64 = AtomicU64::new(1);

struct Shared {
    log: VecDeque<ConnectionLogEntry>,
    /// Replaced for each attempt, since a cancelled token stays cancelled.
    token: CancellationToken,
    live: Option<Live>,
}

impl Shared {
    fn push_log(&mut self, level: LogLevel, message: String) {
        if self.log.len() == LOG_CAPACITY {
            self.log.pop_front();
        }
        self.log.push_back(ConnectionLogEntry {
            ts_ms: now_ms(),
            level,
            message,
        });
    }
}

pub(crate) struct ClusterHandle {
    id: ClusterId,
    kubeconfig_path: PathBuf,
    events: broadcast::Sender<CoreEvent>,
    /// Held by a running attempt. A cancelled attempt can still be writing the
    /// kubeconfig, so the next one waits for it rather than racing it for the file.
    attempt: tokio::sync::Mutex<()>,
    /// Written only while `shared` is locked, so that cancelling and a late
    /// completion cannot interleave and events go out in state order.
    state: watch::Sender<ConnectionState>,
    shared: Mutex<Shared>,
}

impl ClusterHandle {
    fn new(id: &ClusterId, runtime_dir: &Path, events: broadcast::Sender<CoreEvent>) -> Self {
        Self {
            id: id.clone(),
            kubeconfig_path: runtime_dir.join(format!("{id}.yaml")),
            events,
            attempt: tokio::sync::Mutex::new(()),
            state: watch::Sender::new(ConnectionState::Disconnected),
            shared: Mutex::new(Shared {
                log: VecDeque::new(),
                token: CancellationToken::new(),
                live: None,
            }),
        }
    }

    pub(crate) fn log(&self, level: LogLevel, message: impl Into<String>) {
        lock(&self.shared).push_log(level, sanitize_text(&message.into()));
    }

    /// Takes the guard to show that `shared` is locked.
    fn set_state(&self, _shared: &mut MutexGuard<'_, Shared>, state: ConnectionState) {
        self.state.send_replace(state.clone());
        // Sending fails only while nobody is subscribed, and they read the current state.
        let _ = self.events.send(CoreEvent::ClusterState {
            id: self.id.clone(),
            state,
        });
    }

    /// Moves to `Connecting` and returns the new attempt's token, or `None` when
    /// there is already an attempt or a connection for the caller to share.
    fn begin_attempt(&self) -> Option<CancellationToken> {
        let mut shared = lock(&self.shared);
        let idle = matches!(
            *self.state.borrow(),
            ConnectionState::Disconnected | ConnectionState::Failed { .. }
        );
        if !idle {
            return None;
        }
        let token = CancellationToken::new();
        shared.token = token.clone();
        self.set_state(&mut shared, ConnectionState::Connecting);
        Some(token)
    }

    /// Waits for the current attempt, if any, to end.
    async fn settled(&self) -> ConnectionState {
        let mut state = self.state.subscribe();
        let settled = state
            .wait_for(|state| *state != ConnectionState::Connecting)
            .await;
        // `self` keeps the sender alive, so this cannot fail.
        settled.map_or(ConnectionState::Disconnected, |state| state.clone())
    }

    fn finish_attempt(&self, token: &CancellationToken, outcome: Result<Established, Failure>) {
        let mut shared = lock(&self.shared);
        // Disconnect already set the state. It cannot have deleted a file written
        // after it ran, and the next attempt waits for this one, so the file is ours.
        if token.is_cancelled() {
            remove_kubeconfig(&self.kubeconfig_path);
            return;
        }
        let state = match outcome {
            Ok(established) => {
                shared.live = Some(Live {
                    client: established.client,
                    discovery: established.discovery,
                    epoch: NEXT_EPOCH.fetch_add(1, Ordering::Relaxed),
                    resources: None,
                });
                shared.push_log(LogLevel::Info, "connected".to_owned());
                ConnectionState::Connected {
                    info: established.info,
                }
            }
            Err(failure) => {
                remove_kubeconfig(&self.kubeconfig_path);
                let detail = failure.detail.as_ref().unwrap_or(&failure.message);
                shared.push_log(LogLevel::Error, detail.clone());
                ConnectionState::Failed {
                    kind: failure.kind,
                    message: failure.message,
                }
            }
        };
        self.set_state(&mut shared, state);
    }

    fn disconnect(&self) {
        let mut shared = lock(&self.shared);
        shared.token.cancel();
        shared.live = None;
        // Inside the lock, so it cannot delete the file of an attempt begun after this.
        remove_kubeconfig(&self.kubeconfig_path);
        if *self.state.borrow() != ConnectionState::Disconnected {
            shared.push_log(LogLevel::Info, "disconnected".to_owned());
            self.set_state(&mut shared, ConnectionState::Disconnected);
        }
    }
}

async fn run_attempt(
    handle: Arc<ClusterHandle>,
    token: CancellationToken,
    entry: ContextEntry,
    settings: ClusterSettings,
    timeouts: ConnectTimeouts,
) {
    let _running = handle.attempt.lock().await;
    if token.is_cancelled() {
        return;
    }
    handle.log(LogLevel::Info, "building client");
    // Not raced against the token: this could otherwise write the file after the
    // attempt ended, leaving credentials behind. It is only stuck on a dead mount,
    // and then disconnecting still works and the next attempt just waits.
    let prepared = {
        let entry = entry.clone();
        let path = handle.kubeconfig_path.clone();
        tokio::task::spawn_blocking(move || prepare_kubeconfig(&entry, &path)).await
    };
    let outcome = match prepared {
        Ok(Ok(kubeconfig)) => tokio::select! {
            biased;
            () = token.cancelled() => Err(Failure::new(FailureKind::Other, "cancelled")),
            outcome = establish(&handle, kubeconfig, &entry, &settings, &timeouts) => outcome,
        },
        Ok(Err(failure)) => Err(failure),
        Err(e) => Err(Failure::new(
            FailureKind::Other,
            format!("reading the kubeconfig failed: {e}"),
        )),
    };
    handle.finish_attempt(&token, outcome);
}

pub(crate) struct ClusterManager {
    handles: DashMap<ClusterId, Arc<ClusterHandle>>,
    runtime_dir: PathBuf,
    events: broadcast::Sender<CoreEvent>,
    timeouts: Mutex<ConnectTimeouts>,
}

impl ClusterManager {
    /// Removes everything a previous run left under `<data>/runtime/`.
    pub(crate) fn start(data_dir: &Path, events: broadcast::Sender<CoreEvent>) -> Self {
        let runtime_dir = data_dir.join(RUNTIME_DIR);
        reset_runtime_dir(&runtime_dir);
        Self {
            handles: DashMap::new(),
            runtime_dir,
            events,
            timeouts: Mutex::new(ConnectTimeouts::default()),
        }
    }

    /// `<data>/runtime`, emptied at every start.
    pub(crate) fn runtime_dir(&self) -> &Path {
        &self.runtime_dir
    }

    fn handle(&self, id: &ClusterId) -> Option<Arc<ClusterHandle>> {
        self.handles.get(id).map(|handle| handle.value().clone())
    }

    fn all_handles(&self) -> Vec<Arc<ClusterHandle>> {
        self.handles
            .iter()
            .map(|handle| handle.value().clone())
            .collect()
    }

    /// Returns once the attempt this call began or joined has ended. The attempt
    /// runs in its own task, so a caller going away neither stops it nor leaves it stuck.
    pub(crate) async fn connect(
        &self,
        entry: ContextEntry,
        settings: ClusterSettings,
    ) -> ConnectionState {
        let handle = self
            .handles
            .entry(entry.id.clone())
            .or_insert_with(|| {
                Arc::new(ClusterHandle::new(
                    &entry.id,
                    &self.runtime_dir,
                    self.events.clone(),
                ))
            })
            .value()
            .clone();
        if let Some(token) = handle.begin_attempt() {
            let timeouts = lock(&self.timeouts).clone();
            tokio::spawn(run_attempt(
                handle.clone(),
                token,
                entry,
                settings,
                timeouts,
            ));
        }
        handle.settled().await
    }

    pub(crate) fn disconnect(&self, id: &ClusterId) {
        if let Some(handle) = self.handle(id) {
            handle.disconnect();
        }
    }

    pub(crate) fn disconnect_all(&self) {
        for handle in self.all_handles() {
            handle.disconnect();
        }
    }

    pub(crate) fn disconnect_unlisted(&self, entries: &[ContextEntry]) {
        let listed: HashSet<&ClusterId> = entries.iter().map(|entry| &entry.id).collect();
        for handle in self.all_handles() {
            if !listed.contains(&handle.id) {
                handle.disconnect();
            }
        }
    }

    pub(crate) fn state(&self, id: &ClusterId) -> ConnectionState {
        self.handle(id)
            .map_or(ConnectionState::Disconnected, |h| h.state.borrow().clone())
    }

    pub(crate) fn log(&self, id: &ClusterId) -> Vec<ConnectionLogEntry> {
        self.handle(id).map_or_else(Vec::new, |handle| {
            lock(&handle.shared).log.iter().cloned().collect()
        })
    }

    pub(crate) fn set_timeouts(&self, timeouts: ConnectTimeouts) {
        *lock(&self.timeouts) = timeouts;
    }

    /// Reads from the connection's live resources, which exist only while connected.
    fn with_live<T>(
        &self,
        id: &ClusterId,
        read: impl FnOnce(&Live, &ClusterHandle, &Shared) -> T,
    ) -> CoreResult<T> {
        let handle = self.handle(id).ok_or_else(|| not_connected(id))?;
        let shared = lock(&handle.shared);
        let live = shared.live.as_ref().ok_or_else(|| not_connected(id))?;
        Ok(read(live, &handle, &shared))
    }

    pub(crate) fn client(&self, id: &ClusterId) -> CoreResult<Client> {
        self.with_live(id, |live, _, _| live.client.clone())
    }

    pub(crate) fn discovery(&self, id: &ClusterId) -> CoreResult<Arc<Discovery>> {
        self.with_live(id, |live, _, _| live.discovery.clone())
    }

    pub(crate) fn kubeconfig_path(&self, id: &ClusterId) -> CoreResult<PathBuf> {
        self.with_live(id, |_, handle, _| handle.kubeconfig_path.clone())
    }

    /// The connection's identity, for `store_resources`.
    pub(crate) fn epoch(&self, id: &ClusterId) -> CoreResult<u64> {
        self.with_live(id, |live, _, _| live.epoch)
    }

    pub(crate) fn cached_resources(
        &self,
        id: &ClusterId,
    ) -> CoreResult<Option<Arc<Vec<ApiResourceInfo>>>> {
        self.with_live(id, |live, _, _| live.resources.clone())
    }

    /// Runs discovery again on the live client. Nothing is replaced yet.
    pub(crate) async fn rediscover(&self, id: &ClusterId) -> CoreResult<Discovery> {
        let handle = self.handle(id).ok_or_else(|| not_connected(id))?;
        let client = self.client(id)?;
        Ok(run_discovery(&handle, client).await?)
    }

    /// Keeps the result for the connection with this epoch and returns whether
    /// it did. A disconnect or reconnect since the epoch was read drops it.
    pub(crate) fn store_resources(
        &self,
        id: &ClusterId,
        epoch: u64,
        discovery: Option<Discovery>,
        resources: Arc<Vec<ApiResourceInfo>>,
    ) -> bool {
        let Some(handle) = self.handle(id) else {
            return false;
        };
        let mut shared = lock(&handle.shared);
        match shared.live.as_mut() {
            Some(live) if live.epoch == epoch => {
                if let Some(discovery) = discovery {
                    live.discovery = Arc::new(discovery);
                }
                live.resources = Some(resources);
                true
            }
            _ => false,
        }
    }

    /// A child of the connection's token: disconnecting cancels it, and whoever
    /// holds it can cancel only their own work.
    pub(crate) fn cancel_token(&self, id: &ClusterId) -> CoreResult<CancellationToken> {
        self.with_live(id, |_, _, shared| shared.token.child_token())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_keeps_the_newest_entries() {
        let (events, _) = broadcast::channel(1);
        let handle = ClusterHandle::new(&"id".to_owned(), Path::new("/nowhere"), events);

        for n in 0..LOG_CAPACITY + 5 {
            handle.log(LogLevel::Info, n.to_string());
        }

        let shared = lock(&handle.shared);
        assert_eq!(shared.log.len(), LOG_CAPACITY);
        assert_eq!(shared.log[0].message, "5");
    }

    #[test]
    fn log_entry_serializes_for_the_ui() {
        let entry = ConnectionLogEntry {
            ts_ms: 7,
            level: LogLevel::Warn,
            message: "m".to_owned(),
        };

        let v = serde_json::to_value(&entry).unwrap();

        assert_eq!(v["tsMs"], 7);
        assert_eq!(v["level"], "warn");
    }
}
