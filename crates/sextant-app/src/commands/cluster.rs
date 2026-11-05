use sextant_core::cluster::{ConnectionLogEntry, ConnectionState};
use sextant_core::error::IpcError;
use sextant_core::kubeconfig::ClusterId;
use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub async fn cluster_connect(
    state: State<'_, AppState>,
    id: ClusterId,
) -> Result<ConnectionState, IpcError> {
    state.core.cluster_connect(&id).await
}

#[tauri::command]
pub async fn cluster_disconnect(state: State<'_, AppState>, id: ClusterId) -> Result<(), IpcError> {
    state.core.cluster_disconnect(&id).await
}

#[tauri::command]
pub async fn cluster_state(
    state: State<'_, AppState>,
    id: ClusterId,
) -> Result<ConnectionState, IpcError> {
    Ok(state.core.cluster_state(&id))
}

#[tauri::command]
pub async fn cluster_log(
    state: State<'_, AppState>,
    id: ClusterId,
) -> Result<Vec<ConnectionLogEntry>, IpcError> {
    Ok(state.core.cluster_log(&id))
}
