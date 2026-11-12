//! The resource graph (spec E §4.1).

use skopos_core::error::IpcError;
use skopos_core::graph::GraphEvent;
use skopos_core::kubeconfig::ClusterId;
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::mpsc;

use crate::state::AppState;

/// Snapshots wait here while the webview catches up.
const FORWARD_BACKLOG: usize = 8;

/// Streams the cluster's graph to `on_event` and returns the subscription id. When the
/// channel can no longer be written, as after a webview reload, the subscription is ended so
/// its graph does not outlive the page.
#[tauri::command]
pub async fn resource_graph_subscribe(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    namespaces: Option<Vec<String>>,
    on_event: Channel<GraphEvent>,
) -> Result<String, IpcError> {
    let (tx, mut rx) = mpsc::channel(FORWARD_BACKLOG);
    let id = state
        .core
        .resource_graph_subscribe(&cluster_id, namespaces, tx)?;
    let core = state.core.clone();
    let subscription = id.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            if on_event.send(event).is_err() {
                core.resource_graph_unsubscribe(&subscription);
                break;
            }
        }
    });
    Ok(id)
}

#[tauri::command]
pub async fn resource_graph_unsubscribe(
    state: State<'_, AppState>,
    subscription_id: String,
) -> Result<(), IpcError> {
    state.core.resource_graph_unsubscribe(&subscription_id);
    Ok(())
}
