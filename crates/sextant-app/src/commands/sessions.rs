//! Commands shared by every terminal session. These do no file or network work and must
//! not be reordered, so they run in call order on the main thread, unlike the async
//! commands that `mod.rs` describes.

use sextant_core::error::IpcError;
use sextant_core::sessions::TerminalSize;
use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub fn session_write(
    state: State<'_, AppState>,
    session_id: String,
    data: Vec<u8>,
) -> Result<(), IpcError> {
    state.core.session_write(&session_id, data)
}

#[tauri::command]
pub fn session_resize(state: State<'_, AppState>, session_id: String, size: TerminalSize) {
    state.core.session_resize(&session_id, size);
}

#[tauri::command]
pub fn session_ack(state: State<'_, AppState>, session_id: String, bytes: u64) {
    state.core.session_ack(&session_id, bytes);
}

#[tauri::command]
pub fn session_stop(state: State<'_, AppState>, session_id: String) {
    state.core.session_stop(&session_id);
}
