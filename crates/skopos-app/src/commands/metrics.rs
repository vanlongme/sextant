//! Metrics (F16). Each command delegates to `AppCore`.

use skopos_core::error::IpcError;
use skopos_core::kubeconfig::ClusterId;
use skopos_core::metrics::{UsageOf, UsageSnapshot};
use tauri::State;

use crate::state::AppState;

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
