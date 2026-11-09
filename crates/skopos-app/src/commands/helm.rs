//! Helm (F15). Each command delegates to `AppCore`.

use skopos_core::error::IpcError;
use skopos_core::helm::{ChartSearch, ChartVersion, HelmInfo, HelmRepo, HelmRepoAdd};
use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub async fn helm_version(state: State<'_, AppState>) -> Result<HelmInfo, IpcError> {
    state.core.helm_version().await
}

#[tauri::command]
pub async fn helm_repo_list(state: State<'_, AppState>) -> Result<Vec<HelmRepo>, IpcError> {
    state.core.helm_repo_list().await
}

#[tauri::command]
pub async fn helm_repo_add(state: State<'_, AppState>, repo: HelmRepoAdd) -> Result<(), IpcError> {
    state.core.helm_repo_add(repo).await
}

#[tauri::command]
pub async fn helm_repo_remove(state: State<'_, AppState>, name: String) -> Result<(), IpcError> {
    state.core.helm_repo_remove(&name).await
}

#[tauri::command]
pub async fn helm_repo_update(
    state: State<'_, AppState>,
    names: Option<Vec<String>>,
) -> Result<(), IpcError> {
    state.core.helm_repo_update(names).await
}

#[tauri::command]
pub async fn helm_chart_search(
    state: State<'_, AppState>,
    query: String,
    limit: Option<u32>,
) -> Result<ChartSearch, IpcError> {
    state.core.helm_chart_search(&query, limit).await
}

#[tauri::command]
pub async fn helm_chart_versions(
    state: State<'_, AppState>,
    repo: String,
    chart: String,
) -> Result<Vec<ChartVersion>, IpcError> {
    state.core.helm_chart_versions(&repo, &chart).await
}

#[tauri::command]
pub async fn helm_chart_readme(
    state: State<'_, AppState>,
    repo: String,
    chart: String,
    version: String,
) -> Result<String, IpcError> {
    state.core.helm_chart_readme(&repo, &chart, &version).await
}

#[tauri::command]
pub async fn helm_chart_values(
    state: State<'_, AppState>,
    repo: String,
    chart: String,
    version: String,
) -> Result<String, IpcError> {
    state.core.helm_chart_values(&repo, &chart, &version).await
}
