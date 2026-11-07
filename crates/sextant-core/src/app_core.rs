//! `AppCore`, the handle the desktop app and the tests drive everything through.

use std::collections::{HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use dashmap::DashMap;
use serde::Serialize;
use tokio::sync::{broadcast, watch};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use ts_rs::TS;

use crate::catalog::{build_entries, ClusterEntry, PastedConfigs};
use crate::cluster::{ClusterManager, ConnectTimeouts, ConnectionLogEntry, ConnectionState};
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::kubeconfig::{
    default_sources, ClusterId, KubeconfigSync, SyncSnapshot, SyncSource, SyncWarning,
};
use crate::paths::AppPaths;
use crate::prefs::{ClusterSettings, Prefs};
use crate::resources::{RunningDrain, WatchHub};
use crate::sessions::SessionRegistry;
use crate::store::{JsonStore, StoreWarning};
use crate::ui_state::UiState;

const STORE_VERSION: u32 = 1;
const PREFS_FILE: &str = "prefs.json";
const CLUSTERS_FILE: &str = "clusters.json";
const HOTBAR_FILE: &str = "hotbar.json";
const UI_STATE_FILE: &str = "ui-state.json";
/// The safety net under file events, which some filesystems never deliver.
const SYNC_POLL: Duration = Duration::from_secs(10);
const EVENT_BACKLOG: usize = 64;
/// A sync stuck reading a dead mount must not keep the app from exiting.
const SHUTDOWN_LIMIT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase", tag = "type")]
#[ts(export)]
pub enum CoreEvent {
    CatalogChanged,
    ClusterState {
        id: ClusterId,
        state: ConnectionState,
    },
    KubeconfigWarnings {
        warnings: Vec<SyncWarning>,
    },
    StoreWarning {
        warning: StoreWarning,
    },
}

/// A cheap handle to the running core; clones share everything.
#[derive(Clone)]
pub struct AppCore {
    inner: Arc<Inner>,
}

struct Inner {
    prefs: JsonStore<Prefs>,
    clusters: JsonStore<HashMap<ClusterId, ClusterSettings>>,
    hotbar: JsonStore<Vec<ClusterId>>,
    ui_state: UiState,
    pasted: PastedConfigs,
    connections: Arc<ClusterManager>,
    watches: Arc<WatchHub>,
    drains: DashMap<(ClusterId, String), RunningDrain>,
    next_drain: AtomicU64,
    sessions: Arc<SessionRegistry>,
    /// Held across a preferences write and the matching source change, so
    /// concurrent calls cannot leave the sync on sources that were not saved last.
    sync: Mutex<Option<KubeconfigSync>>,
    snapshots: watch::Receiver<SyncSnapshot>,
    sync_events: Mutex<Option<JoinHandle<()>>>,
    events: broadcast::Sender<CoreEvent>,
    startup_warnings: Mutex<Vec<StoreWarning>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Opens the preferences and returns the sources to sync. First run means the
/// file was absent or unusable; a saved list, even an empty one, is respected.
/// A file that could not be moved aside may still hold the saved sources, so the
/// defaults then apply to this session only and nothing is written over it.
fn open_prefs(
    paths: &AppPaths,
    kubeconfig_env: Option<&OsStr>,
    warnings: &mut Vec<StoreWarning>,
) -> (JsonStore<Prefs>, Vec<SyncSource>) {
    let path = paths.config.join(PREFS_FILE);
    let absent = !path.exists();
    let (prefs, warning) = JsonStore::<Prefs>::open(path.clone(), STORE_VERSION);
    let first_run = absent || warning.is_some();
    warnings.extend(warning);
    if !first_run {
        let sources = prefs.get().sync_sources;
        return (prefs, sources);
    }
    let sources = default_sources(&paths.home, kubeconfig_env);
    // When existence cannot be checked, assume the file is there.
    if path.try_exists().unwrap_or(true) {
        return (prefs, sources);
    }
    if let Err(e) = prefs.update(|p| p.sync_sources = sources.clone()) {
        warnings.push(StoreWarning {
            file: PREFS_FILE.to_owned(),
            message: format!("the default kubeconfig sources could not be saved: {e}"),
        });
    }
    (prefs, sources)
}

fn open_store<T>(paths: &AppPaths, file: &str, warnings: &mut Vec<StoreWarning>) -> JsonStore<T>
where
    T: Serialize + serde::de::DeserializeOwned + Default + Clone + Send + Sync + 'static,
{
    let (store, warning) = JsonStore::open(paths.config.join(file), STORE_VERSION);
    warnings.extend(warning);
    store
}

/// Pasted files come first, so they stay `Pasted` when a user source overlaps them.
fn all_sources(pasted: &PastedConfigs, sources: Vec<SyncSource>) -> Vec<SyncSource> {
    let mut all = vec![pasted.source()];
    all.extend(sources);
    all
}

/// Turns sync snapshots into events until the sync stops, and disconnects
/// clusters that left the catalog.
async fn publish_sync_changes(
    mut snapshots: watch::Receiver<SyncSnapshot>,
    events: broadcast::Sender<CoreEvent>,
    connections: Arc<ClusterManager>,
) {
    let mut last = SyncSnapshot::default();
    while snapshots.changed().await.is_ok() {
        let current = snapshots.borrow_and_update().clone();
        // Sending fails only while nobody is subscribed, and they read the current state.
        if current.entries != last.entries {
            connections.disconnect_unlisted(&current.entries);
            let _ = events.send(CoreEvent::CatalogChanged);
        }
        if current.warnings != last.warnings {
            let _ = events.send(CoreEvent::KubeconfigWarnings {
                warnings: current.warnings.clone(),
            });
        }
        last = current;
    }
}

fn source_path(source: &SyncSource) -> &str {
    match source {
        SyncSource::File(path) | SyncSource::Dir(path) => path,
    }
}

impl AppCore {
    /// Reads `KUBECONFIG` from the environment, for use only on first run.
    pub async fn start(paths: AppPaths) -> CoreResult<AppCore> {
        Self::start_with_kubeconfig_env(paths, std::env::var_os("KUBECONFIG")).await
    }

    /// `start` with the `KUBECONFIG` value passed in, so tests never see a real one.
    pub async fn start_with_kubeconfig_env(
        paths: AppPaths,
        kubeconfig_env: Option<OsString>,
    ) -> CoreResult<AppCore> {
        paths.ensure_dirs()?;
        let (events, _) = broadcast::channel(EVENT_BACKLOG);
        let connections = Arc::new(ClusterManager::start(&paths.data, events.clone()));
        let mut warnings = Vec::new();
        let (prefs, sources) = open_prefs(&paths, kubeconfig_env.as_deref(), &mut warnings);
        let clusters = open_store(&paths, CLUSTERS_FILE, &mut warnings);
        let hotbar = open_store(&paths, HOTBAR_FILE, &mut warnings);
        let (ui_state, ui_warning) = UiState::open(paths.config.join(UI_STATE_FILE), STORE_VERSION);
        warnings.extend(ui_warning);
        let pasted = PastedConfigs::open(&paths.data)?;

        let (sync, snapshots) = KubeconfigSync::start(all_sources(&pasted, sources), SYNC_POLL);
        let sync_events = tokio::spawn(publish_sync_changes(
            snapshots.clone(),
            events.clone(),
            connections.clone(),
        ));

        Ok(AppCore {
            inner: Arc::new(Inner {
                prefs,
                clusters,
                hotbar,
                ui_state,
                pasted,
                connections,
                watches: Arc::new(WatchHub::default()),
                drains: DashMap::new(),
                next_drain: AtomicU64::new(1),
                sessions: Arc::new(SessionRegistry::default()),
                sync: Mutex::new(Some(sync)),
                snapshots,
                sync_events: Mutex::new(Some(sync_events)),
                events,
                startup_warnings: Mutex::new(warnings),
            }),
        })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<CoreEvent> {
        self.inner.events.subscribe()
    }

    /// Store problems found while starting. They cannot be sent as events,
    /// which are lost until something subscribes. Later calls return nothing.
    pub fn take_startup_warnings(&self) -> Vec<StoreWarning> {
        std::mem::take(&mut *lock(&self.inner.startup_warnings))
    }

    pub fn catalog_list(&self) -> Vec<ClusterEntry> {
        let contexts = self.inner.snapshots.borrow().entries.clone();
        build_entries(
            contexts,
            &self.inner.clusters.get(),
            &self.inner.pasted,
            |id| self.inner.connections.state(id),
        )
    }

    pub fn catalog_warnings(&self) -> Vec<SyncWarning> {
        self.inner.snapshots.borrow().warnings.clone()
    }

    pub fn catalog_add_pasted(&self, yaml: &str) -> CoreResult<Vec<ClusterId>> {
        self.inner.pasted.add(yaml)
    }

    pub fn catalog_remove_pasted(&self, id: &ClusterId) -> CoreResult<()> {
        if self.inner.pasted.remove(id)? {
            return Ok(());
        }
        // A pasted entry can still be listed here until the sync catches up.
        let synced = self
            .inner
            .snapshots
            .borrow()
            .entries
            .iter()
            .any(|entry| entry.id == *id && !self.inner.pasted.holds(&entry.source_path));
        Err(if synced {
            IpcError::new(
                ErrorCode::InvalidInput,
                "only pasted clusters can be removed from the catalog",
            )
        } else {
            IpcError::new(ErrorCode::NotFound, format!("no pasted cluster {id}"))
        })
    }

    pub fn ui_state_get(&self, key: &str) -> Option<serde_json::Value> {
        self.inner.ui_state.get(key)
    }

    pub fn ui_state_set(&self, key: &str, value: serde_json::Value) -> CoreResult<()> {
        self.inner.ui_state.set(key, value)
    }

    pub fn cluster_settings_get(&self, id: &ClusterId) -> ClusterSettings {
        self.inner
            .clusters
            .get()
            .get(id)
            .cloned()
            .unwrap_or_default()
    }

    pub fn cluster_settings_set(&self, id: &ClusterId, s: ClusterSettings) -> CoreResult<()> {
        self.inner.clusters.update(|all| {
            all.insert(id.clone(), s);
        })?;
        // Entries carry the display name and icon.
        let _ = self.inner.events.send(CoreEvent::CatalogChanged);
        Ok(())
    }

    /// The pinned clusters in the catalog right now. Others stay saved, so a
    /// pin survives its file being briefly gone.
    pub fn hotbar_get(&self) -> Vec<ClusterId> {
        let listed: HashSet<ClusterId> = self
            .inner
            .snapshots
            .borrow()
            .entries
            .iter()
            .map(|entry| entry.id.clone())
            .collect();
        let mut pinned = self.inner.hotbar.get();
        pinned.retain(|id| listed.contains(id));
        pinned
    }

    pub fn hotbar_set(&self, ids: Vec<ClusterId>) -> CoreResult<()> {
        let listed: HashSet<ClusterId> = self
            .inner
            .snapshots
            .borrow()
            .entries
            .iter()
            .map(|entry| entry.id.clone())
            .collect();
        // Pins the catalog does not list right now are kept, at their relative positions.
        self.inner.hotbar.update(|stored| {
            let mut merged = ids;
            let mut anchor: Option<ClusterId> = None;
            for id in stored.iter() {
                if listed.contains(id) || merged.contains(id) {
                    if merged.contains(id) {
                        anchor = Some(id.clone());
                    }
                    continue;
                }
                let at = anchor
                    .as_ref()
                    .and_then(|a| merged.iter().position(|m| m == a))
                    .map_or(0, |i| i + 1);
                merged.insert(at, id.clone());
                anchor = Some(id.clone());
            }
            *stored = merged;
        })?;
        Ok(())
    }

    /// Idempotent, and concurrent calls join one attempt. A failed attempt is
    /// `Ok(Failed)`; the error case is an id the catalog does not list.
    pub async fn cluster_connect(&self, id: &ClusterId) -> CoreResult<ConnectionState> {
        let entry = self
            .inner
            .snapshots
            .borrow()
            .entries
            .iter()
            .find(|entry| entry.id == *id)
            .cloned()
            .ok_or_else(|| IpcError::new(ErrorCode::NotFound, format!("no cluster {id}")))?;
        let settings = self.cluster_settings_get(id);
        Ok(self.inner.connections.connect(entry, settings).await)
    }

    pub async fn cluster_disconnect(&self, id: &ClusterId) -> CoreResult<()> {
        self.inner.connections.disconnect(id);
        Ok(())
    }

    pub fn cluster_state(&self, id: &ClusterId) -> ConnectionState {
        self.inner.connections.state(id)
    }

    pub fn cluster_log(&self, id: &ClusterId) -> Vec<ConnectionLogEntry> {
        self.inner.connections.log(id)
    }

    pub fn cluster_client(&self, id: &ClusterId) -> CoreResult<kube::Client> {
        self.inner.connections.client(id)
    }

    pub fn cluster_kubeconfig_path(&self, id: &ClusterId) -> CoreResult<PathBuf> {
        self.inner.connections.kubeconfig_path(id)
    }

    pub fn cluster_cancel_token(&self, id: &ClusterId) -> CoreResult<CancellationToken> {
        self.inner.connections.cancel_token(id)
    }

    pub fn cluster_discovery(&self, id: &ClusterId) -> CoreResult<Arc<kube::Discovery>> {
        self.inner.connections.discovery(id)
    }

    pub(crate) fn connections(&self) -> &ClusterManager {
        &self.inner.connections
    }

    pub(crate) fn watches(&self) -> &Arc<WatchHub> {
        &self.inner.watches
    }

    pub(crate) fn drains(&self) -> &DashMap<(ClusterId, String), RunningDrain> {
        &self.inner.drains
    }

    pub(crate) fn next_drain_id(&self) -> String {
        let number = self.inner.next_drain.fetch_add(1, Ordering::Relaxed);
        format!("drain-{number}")
    }

    pub(crate) fn sessions(&self) -> &Arc<SessionRegistry> {
        &self.inner.sessions
    }

    pub fn set_connect_timeouts_for_test(&self, t: ConnectTimeouts) {
        self.inner.connections.set_timeouts(t);
    }

    pub fn prefs_get(&self) -> Prefs {
        self.inner.prefs.get()
    }

    /// Saves `p` and applies its sync sources immediately.
    pub fn prefs_set(&self, p: Prefs) -> CoreResult<()> {
        // Cluster ids hash the path, so a relative one would change between launches.
        if let Some(path) = p
            .sync_sources
            .iter()
            .map(source_path)
            .find(|path| !Path::new(path).is_absolute())
        {
            return Err(IpcError::new(
                ErrorCode::InvalidInput,
                format!("a kubeconfig source must be an absolute path: {path}"),
            ));
        }
        let sync = lock(&self.inner.sync);
        let sources = p.sync_sources.clone();
        self.inner.prefs.update(|prefs| *prefs = p)?;
        if let Some(sync) = sync.as_ref() {
            sync.set_sources(all_sources(&self.inner.pasted, sources));
        }
        Ok(())
    }

    /// Stops every session and waits for their cleanup, which a node shell needs the
    /// network for. Then disconnects every cluster and stops background work. The last
    /// snapshot stays readable.
    pub async fn shutdown(&self) {
        self.sessions_stop_all();
        if !self.sessions_wait_idle(SHUTDOWN_LIMIT).await {
            tracing::warn!("some sessions did not stop within {SHUTDOWN_LIMIT:?}");
        }
        self.inner.connections.disconnect_all();
        let sync = lock(&self.inner.sync).take();
        let sync_events = lock(&self.inner.sync_events).take();
        let stopped = async {
            if let Some(sync) = sync {
                // Stopping joins a thread, which must not block the runtime.
                let _ = tokio::task::spawn_blocking(move || sync.stop()).await;
            }
            if let Some(sync_events) = sync_events {
                let _ = sync_events.await;
            }
        };
        if tokio::time::timeout(SHUTDOWN_LIMIT, stopped).await.is_err() {
            tracing::warn!("the kubeconfig sync did not stop within {SHUTDOWN_LIMIT:?}");
        }
    }
}
