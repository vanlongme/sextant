//! Metrics (F16). Each command delegates to `AppCore`.

use skopos_core::error::IpcError;
use skopos_core::kubeconfig::ClusterId;
use skopos_core::metrics::{MetricsProvider, UsageOf, UsageSnapshot};
use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub async fn metrics_provider(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    refresh: bool,
) -> Result<MetricsProvider, IpcError> {
    state.core.metrics_provider(&cluster_id, refresh).await
}

#[tauri::command]
pub async fn metrics_usage(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    of: UsageOf,
    namespace: Option<String>,
) -> Result<UsageSnapshot, IpcError> {
    state
        .core
        .metrics_usage(&cluster_id, of, namespace.as_deref())
        .await
}
