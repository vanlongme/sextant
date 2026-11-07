use sextant_core::error::{ErrorCode, IpcError};
use sextant_core::external_url::check_external_url;
use sextant_core::portforward::{PortForward, PortForwardSpec};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::state::AppState;

#[tauri::command]
pub async fn portforward_list(state: State<'_, AppState>) -> Result<Vec<PortForward>, IpcError> {
    Ok(state.core.portforward_list())
}

#[tauri::command]
pub async fn portforward_add(
    state: State<'_, AppState>,
    spec: PortForwardSpec,
) -> Result<PortForward, IpcError> {
    state.core.portforward_add(spec)
}

#[tauri::command]
pub async fn portforward_start(
    state: State<'_, AppState>,
    id: String,
) -> Result<PortForward, IpcError> {
    state.core.portforward_start(&id).await
}

#[tauri::command]
pub async fn portforward_stop(state: State<'_, AppState>, id: String) -> Result<(), IpcError> {
    state.core.portforward_stop(&id).await;
    Ok(())
}

#[tauri::command]
pub async fn portforward_remove(state: State<'_, AppState>, id: String) -> Result<(), IpcError> {
    state.core.portforward_remove(&id).await
}

/// The only way a URL leaves the app. The webview holds no opener permission, so this check
/// cannot be stepped around (section 5.5 of the milestone spec).
#[tauri::command]
pub async fn open_external(app: AppHandle, url: String) -> Result<(), IpcError> {
    let checked = check_external_url(&url)?;
    app.opener()
        .open_url(checked, None::<&str>)
        .map_err(|error| IpcError::new(ErrorCode::Internal, error.to_string()))
}
