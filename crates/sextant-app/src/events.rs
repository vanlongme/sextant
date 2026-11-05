//! Forwards core events to the webview as Tauri events.

use std::time::Duration;

use serde::Serialize;
use sextant_core::app_core::{AppCore, CoreEvent};
use sextant_core::cluster::ConnectionState;
use sextant_core::kubeconfig::ClusterId;
use tauri::{AppHandle, Emitter};
use tokio::sync::broadcast::error::RecvError;

const CATALOG_CHANGED: &str = "catalog://changed";
const CLUSTER_STATE: &str = "cluster://state";
const KUBECONFIG_WARNINGS: &str = "kubeconfig://warnings";
const STORE_WARNING: &str = "store://warning";

/// The page has loaded by the time this starts, but its listeners register
/// asynchronously afterwards, and an event sent before that is lost.
const LISTENER_GRACE: Duration = Duration::from_secs(1);

#[derive(Clone, Serialize)]
struct ClusterStatePayload {
    id: ClusterId,
    state: ConnectionState,
}

fn emit(app: &AppHandle, event: CoreEvent) {
    let sent = match event {
        CoreEvent::CatalogChanged => app.emit(CATALOG_CHANGED, ()),
        CoreEvent::ClusterState { id, state } => {
            app.emit(CLUSTER_STATE, ClusterStatePayload { id, state })
        }
        CoreEvent::KubeconfigWarnings { warnings } => app.emit(KUBECONFIG_WARNINGS, warnings),
        CoreEvent::StoreWarning { warning } => app.emit(STORE_WARNING, warning),
    };
    if let Err(e) = sent {
        tracing::warn!("cannot send an event to the window: {e}");
    }
}

pub fn spawn_forwarder(app: AppHandle, core: AppCore) {
    let mut events = core.subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            match events.recv().await {
                Ok(event) => emit(&app, event),
                // Events were missed, so have the UI read the current state again.
                Err(RecvError::Lagged(missed)) => {
                    tracing::warn!("missed {missed} core events");
                    emit(&app, CoreEvent::CatalogChanged);
                    let warnings = core.catalog_warnings();
                    emit(&app, CoreEvent::KubeconfigWarnings { warnings });
                }
                Err(RecvError::Closed) => return,
            }
        }
    });
}

/// Call once the page has loaded. Each warning is sent only once, so a reload
/// does not repeat them, and logged in case the page was not listening yet.
pub fn send_startup_warnings(app: &AppHandle, core: &AppCore) {
    let warnings = core.take_startup_warnings();
    if warnings.is_empty() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(LISTENER_GRACE).await;
        for warning in warnings {
            tracing::warn!("{}: {}", warning.file, warning.message);
            emit(&app, CoreEvent::StoreWarning { warning });
        }
    });
}
