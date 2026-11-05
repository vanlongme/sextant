use sextant_core::catalog::ClusterEntry;
use sextant_core::error::IpcError;
use sextant_core::kubeconfig::{ClusterId, SyncWarning};
use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub async fn catalog_list(state: State<'_, AppState>) -> Result<Vec<ClusterEntry>, IpcError> {
    Ok(state.core.catalog_list())
}

#[tauri::command]
pub async fn catalog_warnings(state: State<'_, AppState>) -> Result<Vec<SyncWarning>, IpcError> {
    Ok(state.core.catalog_warnings())
}

#[tauri::command]
pub async fn catalog_add_pasted(
    state: State<'_, AppState>,
    yaml: String,
) -> Result<Vec<ClusterId>, IpcError> {
    state.core.catalog_add_pasted(&yaml)
}

#[tauri::command]
pub async fn catalog_remove_pasted(
    state: State<'_, AppState>,
    id: ClusterId,
) -> Result<(), IpcError> {
    state.core.catalog_remove_pasted(&id)
}
