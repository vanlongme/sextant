use sextant_core::error::IpcError;
use sextant_core::kubeconfig::ClusterId;
use sextant_core::resources::{DataChange, ResourceRef, SecretValue};
use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub async fn workload_scale(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    resource: ResourceRef,
    namespace: String,
    name: String,
    replicas: i32,
) -> Result<(), IpcError> {
    state
        .core
        .workload_scale(&cluster_id, &resource, &namespace, &name, replicas)
        .await
}

#[tauri::command]
pub async fn workload_restart(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    resource: ResourceRef,
    namespace: String,
    name: String,
) -> Result<(), IpcError> {
    state
        .core
        .workload_restart(&cluster_id, &resource, &namespace, &name)
        .await
}

#[tauri::command]
pub async fn pod_evict(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    namespace: String,
    name: String,
) -> Result<(), IpcError> {
    state.core.pod_evict(&cluster_id, &namespace, &name).await
}

#[tauri::command]
pub async fn cronjob_trigger(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    namespace: String,
    name: String,
) -> Result<String, IpcError> {
    state
        .core
        .cronjob_trigger(&cluster_id, &namespace, &name)
        .await
}

#[tauri::command]
pub async fn cronjob_set_suspend(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    namespace: String,
    name: String,
    suspend: bool,
) -> Result<(), IpcError> {
    state
        .core
        .cronjob_set_suspend(&cluster_id, &namespace, &name, suspend)
        .await
}

#[tauri::command]
pub async fn node_set_unschedulable(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    name: String,
    unschedulable: bool,
) -> Result<(), IpcError> {
    state
        .core
        .node_set_unschedulable(&cluster_id, &name, unschedulable)
        .await
}

#[tauri::command]
pub async fn secret_reveal(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    namespace: String,
    name: String,
    key: String,
) -> Result<SecretValue, IpcError> {
    state
        .core
        .secret_reveal(&cluster_id, &namespace, &name, &key)
        .await
}

#[tauri::command]
pub async fn secret_update(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    namespace: String,
    name: String,
    resource_version: String,
    changes: Vec<DataChange>,
) -> Result<(), IpcError> {
    state
        .core
        .secret_update(&cluster_id, &namespace, &name, &resource_version, changes)
        .await
}

#[tauri::command]
pub async fn configmap_update(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    namespace: String,
    name: String,
    resource_version: String,
    changes: Vec<DataChange>,
) -> Result<(), IpcError> {
    state
        .core
        .configmap_update(&cluster_id, &namespace, &name, &resource_version, changes)
        .await
}
