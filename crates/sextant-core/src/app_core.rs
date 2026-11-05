//! `AppCore`, the handle the desktop app and the tests drive everything through.

use std::collections::{HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use serde::Serialize;
use tokio::sync::{broadcast, watch};
use tokio::task::JoinHandle;
use ts_rs::TS;

use crate::catalog::{build_entries, ClusterEntry, PastedConfigs};
use crate::cluster::ConnectionState;
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::kubeconfig::{
    default_sources, ClusterId, KubeconfigSync, SyncSnapshot, SyncSource, SyncWarning,
};
use crate::paths::AppPaths;
use crate::prefs::{ClusterSettings, Prefs};
use crate::store::{JsonStore, StoreWarning};

const STORE_VERSION: u32 = 1;
const PREFS_FILE: &str = "prefs.json";
const CLUSTERS_FILE: &str = "clusters.json";
const HOTBAR_FILE: &str = "hotbar.json";
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
    pasted: PastedConfigs,
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

/// Turns sync snapshots into events until the sync stops.
async fn publish_sync_changes(
    mut snapshots: watch::Receiver<SyncSnapshot>,
    events: broadcast::Sender<CoreEvent>,
) {
    let mut last = SyncSnapshot::default();
    while snapshots.changed().await.is_ok() {
        let current = snapshots.borrow_and_update().clone();
        // Sending fails only while nobody is subscribed, and they read the current state.
        if current.entries != last.entries {
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
        let mut warnings = Vec::new();
        let (prefs, sources) = open_prefs(&paths, kubeconfig_env.as_deref(), &mut warnings);
        let clusters = open_store(&paths, CLUSTERS_FILE, &mut warnings);
        let hotbar = open_store(&paths, HOTBAR_FILE, &mut warnings);
        let pasted = PastedConfigs::open(&paths.data)?;

        let (sync, snapshots) = KubeconfigSync::start(all_sources(&pasted, sources), SYNC_POLL);
        let (events, _) = broadcast::channel(EVENT_BACKLOG);
        let sync_events = tokio::spawn(publish_sync_changes(snapshots.clone(), events.clone()));

        Ok(AppCore {
            inner: Arc::new(Inner {
                prefs,
                clusters,
                hotbar,
                pasted,
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
        build_entries(contexts, &self.inner.clusters.get(), &self.inner.pasted)
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
        self.inner.hotbar.update(|pinned| *pinned = ids)?;
        Ok(())
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

    /// Stops background work. The last snapshot stays readable.
    pub async fn shutdown(&self) {
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
