use skopos_core::app_core::AppCore;

/// What commands reach through `tauri::State`.
pub struct AppState {
    pub core: AppCore,
}
