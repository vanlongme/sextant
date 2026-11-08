//! Argo CD Application actions. The logic is in `skopos_core::resources::argocd`.

use skopos_core::error::IpcError;
use skopos_core::kubeconfig::ClusterId;
use skopos_core::resources::ArgoSyncOptions;
use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub async fn argocd_sync(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    namespace: String,
    name: String,
    options: ArgoSyncOptions,
) -> Result<(), IpcError> {
    state
        .core
        .argocd_sync(&cluster_id, &namespace, &name, &options)
        .await
}
