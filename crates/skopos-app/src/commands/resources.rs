use serde_json::Value;
use skopos_core::error::IpcError;
use skopos_core::kubeconfig::ClusterId;
use skopos_core::resources::{
    ApiResourceInfo, ApplyResult, InvolvedRef, Propagation, ResourceRef, WatchEvent,
};
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::mpsc;

use crate::state::AppState;

/// Events wait here while the webview catches up.
const FORWARD_BACKLOG: usize = 64;

#[tauri::command]
pub async fn resources_discover(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    refresh: bool,
) -> Result<Vec<ApiResourceInfo>, IpcError> {
    state.core.resources_discover(&cluster_id, refresh).await
}

/// Streams the resource to `on_event` and returns the subscription id. When the
/// channel can no longer be written, as after a webview reload, the subscription
/// is ended so its watch does not outlive the page.
#[tauri::command]
pub async fn resources_subscribe(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    resource: ResourceRef,
    on_event: Channel<WatchEvent>,
) -> Result<String, IpcError> {
    let (tx, mut rx) = mpsc::channel(FORWARD_BACKLOG);
    let id = state
        .core
        .resources_subscribe(&cluster_id, resource, tx)
        .await?;
    let core = state.core.clone();
    let subscription = id.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            if on_event.send(event).is_err() {
                core.resources_unsubscribe(&subscription);
                break;
            }
        }
    });
    Ok(id)
}

#[tauri::command]
pub async fn resources_unsubscribe(
    state: State<'_, AppState>,
    subscription_id: String,
) -> Result<(), IpcError> {
    state.core.resources_unsubscribe(&subscription_id);
    Ok(())
}

#[tauri::command]
pub async fn resources_list(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    resource: ResourceRef,
    namespace: Option<String>,
    label_selector: Option<String>,
    field_selector: Option<String>,
) -> Result<Vec<Value>, IpcError> {
    state
        .core
        .resources_list(
            &cluster_id,
            &resource,
            namespace.as_deref(),
            label_selector.as_deref(),
            field_selector.as_deref(),
        )
        .await
}

#[tauri::command]
pub async fn resource_get(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    resource: ResourceRef,
    namespace: Option<String>,
    name: String,
) -> Result<Value, IpcError> {
    state
        .core
        .resource_get(&cluster_id, &resource, namespace.as_deref(), &name)
        .await
}

#[tauri::command]
pub async fn resource_get_yaml(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    resource: ResourceRef,
    namespace: Option<String>,
    name: String,
) -> Result<String, IpcError> {
    state
        .core
        .resource_get_yaml(&cluster_id, &resource, namespace.as_deref(), &name)
        .await
}

#[tauri::command]
pub async fn resource_replace(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    resource: ResourceRef,
    namespace: Option<String>,
    name: String,
    yaml: String,
    force: bool,
) -> Result<Value, IpcError> {
    state
        .core
        .resource_replace(
            &cluster_id,
            &resource,
            namespace.as_deref(),
            &name,
            &yaml,
            force,
        )
        .await
}

#[tauri::command]
pub async fn resource_apply(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    yaml: String,
    default_namespace: String,
) -> Result<Vec<ApplyResult>, IpcError> {
    state
        .core
        .resource_apply(&cluster_id, &yaml, &default_namespace)
        .await
}

#[tauri::command]
pub async fn resource_delete(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    resource: ResourceRef,
    namespace: Option<String>,
    name: String,
    propagation: Propagation,
) -> Result<(), IpcError> {
    state
        .core
        .resource_delete(
            &cluster_id,
            &resource,
            namespace.as_deref(),
            &name,
            propagation,
        )
        .await
}

#[tauri::command]
pub async fn resource_events(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    involved: InvolvedRef,
) -> Result<Vec<Value>, IpcError> {
    state.core.resource_events(&cluster_id, &involved).await
}

#[tauri::command]
pub async fn ui_state_get(
    state: State<'_, AppState>,
    key: String,
) -> Result<Option<Value>, IpcError> {
    Ok(state.core.ui_state_get(&key))
}

#[tauri::command]
pub async fn ui_state_set(
    state: State<'_, AppState>,
    key: String,
    value: Value,
) -> Result<(), IpcError> {
    state.core.ui_state_set(&key, value)
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use skopos_core::resources::Row;
    use tauri::ipc::{InvokeResponseBody, IpcResponse};

    use super::*;

    /// A row is kept as text, and must still reach the webview as the object.
    #[test]
    fn a_watched_row_crosses_the_channel_as_its_object() {
        let object =
            json!({ "kind": "Pod", "metadata": { "name": "web", "labels": { "app": "web" } } });
        let event = WatchEvent::Snapshot {
            items: vec![Row::new(&object).unwrap()],
        };
        let InvokeResponseBody::Json(body) = event.body().unwrap() else {
            panic!("the event did not cross as JSON");
        };
        let sent: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(sent, json!({ "type": "snapshot", "items": [object] }));
    }
}
