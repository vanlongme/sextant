use skopos_core::error::IpcError;
use skopos_core::tools::ToolStatus;
use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub async fn tools_status(state: State<'_, AppState>) -> Result<Vec<ToolStatus>, IpcError> {
    Ok(state.core.tools_status().await)
}
