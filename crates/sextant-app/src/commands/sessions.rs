//! Terminal sessions. The start commands are async like the others. The commands shared by
//! every session do no file or network work and must not be reordered, so they are sync and
//! run in call order on the main thread, unlike the async commands that `mod.rs` describes.

use sextant_core::app_core::AppCore;
use sextant_core::error::IpcError;
use sextant_core::kubeconfig::ClusterId;
use sextant_core::sessions::{SessionEvent, SessionOutput, TerminalSize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;
use tokio::sync::mpsc;

use crate::state::AppState;

/// Output waits here while the webview catches up. Flow control keeps it small.
const OUTPUT_BACKLOG: usize = 32;

/// Hands a session's output to its two channels: raw bytes, and events as JSON. The first
/// failed send stops the session. The last event ends the forwarding, because a process
/// left holding the PTY could keep this channel open.
fn forward_output(
    core: AppCore,
    session: String,
    mut output: mpsc::Receiver<SessionOutput>,
    on_data: Channel<InvokeResponseBody>,
    on_event: Channel<SessionEvent>,
) {
    tauri::async_runtime::spawn(async move {
        while let Some(item) = output.recv().await {
            let (sent, last) = match item {
                SessionOutput::Data(data) => (on_data.send(InvokeResponseBody::Raw(data)), false),
                SessionOutput::Event(event) => {
                    let last = matches!(
                        event,
                        SessionEvent::Exited { .. } | SessionEvent::Failed { .. }
                    );
                    (on_event.send(event), last)
                }
            };
            if sent.is_err() {
                core.session_stop(&session);
                break;
            }
            if last {
                break;
            }
        }
    });
}

#[tauri::command]
pub async fn terminal_start(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    size: TerminalSize,
    on_data: Channel<InvokeResponseBody>,
    on_event: Channel<SessionEvent>,
) -> Result<String, IpcError> {
    let (tx, rx) = mpsc::channel(OUTPUT_BACKLOG);
    let id = state.core.terminal_start(&cluster_id, size, tx).await?;
    forward_output(state.core.clone(), id.clone(), rx, on_data, on_event);
    Ok(id)
}

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
