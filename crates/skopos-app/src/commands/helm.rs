//! Helm (F15). Each command delegates to `AppCore`.

use skopos_core::error::IpcError;
use skopos_core::helm::HelmInfo;
use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub async fn helm_version(state: State<'_, AppState>) -> Result<HelmInfo, IpcError> {
    state.core.helm_version().await
}
