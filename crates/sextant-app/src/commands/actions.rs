use std::path::PathBuf;

use sextant_core::error::IpcError;
use sextant_core::kubeconfig::ClusterId;
use sextant_core::resources::{
    DataChange, DrainEvent, DrainOptions, ResourceRef, SavedKubeconfig, SecretValue,
};
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::mpsc;

use crate::state::AppState;

/// Events wait here while the webview catches up.
const DRAIN_BACKLOG: usize = 64;

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
pub async fn node_drain_start(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    name: String,
    options: DrainOptions,
    on_event: Channel<DrainEvent>,
) -> Result<String, IpcError> {
    let (tx, mut rx) = mpsc::channel(DRAIN_BACKLOG);
    let id = state
        .core
        .node_drain_start(&cluster_id, &name, options, tx)
        .await?;
    let core = state.core.clone();
    let drain = id.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            if on_event.send(event).is_err() {
                core.node_drain_cancel(&drain);
                break;
            }
        }
    });
    Ok(id)
}

#[tauri::command]
pub async fn node_drain_cancel(
    state: State<'_, AppState>,
    drain_id: String,
) -> Result<(), IpcError> {
    state.core.node_drain_cancel(&drain_id);
    Ok(())
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

#[tauri::command]
pub async fn pod_force_delete(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    namespace: String,
    name: String,
    uid: String,
) -> Result<(), IpcError> {
    state
        .core
        .pod_force_delete(&cluster_id, &namespace, &name, &uid)
        .await
}

#[tauri::command]
pub async fn resource_force_finalize(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    resource: ResourceRef,
    namespace: Option<String>,
    name: String,
) -> Result<(), IpcError> {
    state
        .core
        .resource_force_finalize(&cluster_id, &resource, namespace.as_deref(), &name)
        .await
}

#[tauri::command]
pub async fn job_set_suspend(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    namespace: String,
    name: String,
    suspend: bool,
) -> Result<(), IpcError> {
    state
        .core
        .job_set_suspend(&cluster_id, &namespace, &name, suspend)
        .await
}

#[tauri::command]
pub async fn ingress_class_set_default(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    name: String,
) -> Result<(), IpcError> {
    state
        .core
        .ingress_class_set_default(&cluster_id, &name)
        .await
}

#[tauri::command]
pub async fn service_account_kubeconfig_save(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    namespace: String,
    name: String,
    dest_path: PathBuf,
    expiration_seconds: Option<i64>,
) -> Result<SavedKubeconfig, IpcError> {
    state
        .core
        .service_account_kubeconfig_save(
            &cluster_id,
            &namespace,
            &name,
            &dest_path,
            expiration_seconds,
        )
        .await
}
