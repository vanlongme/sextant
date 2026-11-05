use sextant_core::error::IpcError;
use sextant_core::kubeconfig::ClusterId;
use sextant_core::prefs::{ClusterSettings, Prefs};
use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub async fn cluster_settings_get(
    state: State<'_, AppState>,
    id: ClusterId,
) -> Result<ClusterSettings, IpcError> {
    Ok(state.core.cluster_settings_get(&id))
}

#[tauri::command]
pub async fn cluster_settings_set(
    state: State<'_, AppState>,
    id: ClusterId,
    settings: ClusterSettings,
) -> Result<(), IpcError> {
    state.core.cluster_settings_set(&id, settings)
}

#[tauri::command]
pub async fn hotbar_get(state: State<'_, AppState>) -> Result<Vec<ClusterId>, IpcError> {
    Ok(state.core.hotbar_get())
}

#[tauri::command]
pub async fn hotbar_set(state: State<'_, AppState>, ids: Vec<ClusterId>) -> Result<(), IpcError> {
    state.core.hotbar_set(ids)
}

#[tauri::command]
pub async fn prefs_get(state: State<'_, AppState>) -> Result<Prefs, IpcError> {
    Ok(state.core.prefs_get())
}

#[tauri::command]
pub async fn prefs_set(state: State<'_, AppState>, prefs: Prefs) -> Result<(), IpcError> {
    state.core.prefs_set(prefs)
}
