use skopos_core::error::IpcError;
use skopos_core::tools::{ToolName, ToolStatus};
use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub async fn tools_status(state: State<'_, AppState>) -> Result<Vec<ToolStatus>, IpcError> {
    Ok(state.core.tools_status().await)
}

#[tauri::command]
pub async fn tools_download(
    state: State<'_, AppState>,
    tool: ToolName,
) -> Result<ToolStatus, IpcError> {
    state.core.tools_download(tool).await
}

#[tauri::command]
pub async fn tools_download_cancel(
    state: State<'_, AppState>,
    tool: ToolName,
) -> Result<(), IpcError> {
    state.core.tools_download_cancel(tool);
    Ok(())
}
