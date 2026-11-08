//! Argo CD Application actions. The logic is in `skopos_core::resources::argocd`.

use skopos_core::error::IpcError;
use skopos_core::kubeconfig::ClusterId;
use skopos_core::resources::{ArgoRollbackOptions, ArgoSyncOptions};
use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub async fn argocd_sync(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    namespace: String,
    name: String,
    options: ArgoSyncOptions,
) -> Result<(), IpcError> {
    state
        .core
        .argocd_sync(&cluster_id, &namespace, &name, &options)
        .await
}

#[tauri::command]
pub async fn argocd_rollback(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    namespace: String,
    name: String,
    options: ArgoRollbackOptions,
) -> Result<(), IpcError> {
    state
        .core
        .argocd_rollback(&cluster_id, &namespace, &name, &options)
        .await
}

#[tauri::command]
pub async fn argocd_terminate(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    namespace: String,
    name: String,
) -> Result<(), IpcError> {
    state
        .core
        .argocd_terminate(&cluster_id, &namespace, &name)
        .await
}

#[tauri::command]
pub async fn argocd_refresh(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    namespace: String,
    name: String,
    hard: bool,
) -> Result<(), IpcError> {
    state
        .core
        .argocd_refresh(&cluster_id, &namespace, &name, hard)
        .await
}

#[tauri::command]
pub async fn argocd_delete(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    namespace: String,
    name: String,
    cascade: bool,
) -> Result<(), IpcError> {
    state
        .core
        .argocd_delete(&cluster_id, &namespace, &name, cascade)
        .await
}
