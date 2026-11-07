//! Pod shell and attach (F12), over the exec and attach APIs. The node shell runs on the
//! same code once its pod is up.

use std::sync::Arc;
use std::time::Duration;

use futures::SinkExt;
use k8s_openapi::api::core::v1::Pod;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::Status;
use kube::api::{AttachParams, AttachedProcess, TerminalSize as RemoteSize};
use kube::Api;
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use super::{read_pod, FlowControl, SessionEvent, SessionOutput, TerminalControl, TerminalSize};
use crate::app_core::AppCore;
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::kubeconfig::ClusterId;
use crate::resources::{invalid, is_path_segment};

const DEFAULT_CONTAINER: &str = "kubectl.kubernetes.io/default-container";
const READ_CHUNK: usize = 16 * 1024;
const INPUT_BACKLOG: usize = 64;
/// The library's default of 1 KiB would split nearly every chunk of output.
const STREAM_BUFFER: usize = 64 * 1024;
/// After the output ended, how long the exit status may take to arrive.
const STATUS_LIMIT: Duration = Duration::from_secs(2);

/// `bash` when the image has it, else `sh` (F12).
pub(super) const SHELL: [&str; 3] = [
    "sh",
    "-c",
    "command -v bash >/dev/null 2>&1 && exec bash; exec sh",
];

fn named<'a>(list: Option<&'a Value>, name: &str) -> Option<&'a Value> {
    list?
        .as_array()?
        .iter()
        .find(|entry| entry.get("name").and_then(Value::as_str) == Some(name))
}

fn declared_container<'a>(pod: &'a Value, name: &str) -> Option<&'a Value> {
    named(pod.pointer("/spec/containers"), name)
        .or_else(|| named(pod.pointer("/spec/initContainers"), name))
}

/// The annotation's container if the pod declares it, else the first container.
fn default_container(pod: &Value) -> Option<String> {
    let annotated = pod
        .pointer("/metadata/annotations")
        .and_then(|annotations| annotations.get(DEFAULT_CONTAINER))
        .and_then(Value::as_str)
        .filter(|name| declared_container(pod, name).is_some());
    annotated
        .or_else(|| {
            pod.pointer("/spec/containers/0/name")
                .and_then(Value::as_str)
        })
        .map(str::to_owned)
}

fn choose_container(pod: &Value, requested: Option<String>) -> CoreResult<String> {
    match requested.or_else(|| default_container(pod)) {
        Some(container) if declared_container(pod, &container).is_some() => Ok(container),
        Some(container) => Err(IpcError::new(
            ErrorCode::NotFound,
            format!("the pod has no container {container}"),
        )),
        None => Err(IpcError::new(
            ErrorCode::NotFound,
            "the pod declares no containers",
        )),
    }
}

/// What attaching to a container can do. A TTY exists only if the spec asked for one, and
/// input applies only to a container with both a TTY and stdin open.
#[derive(Debug, PartialEq, Eq)]
struct AttachMode {
    tty: bool,
    interactive: bool,
}

fn attach_mode(container: &Value) -> AttachMode {
    let flag = |name: &str| container.get(name).and_then(Value::as_bool) == Some(true);
    let tty = flag("tty");
    AttachMode {
        tty,
        interactive: tty && flag("stdin"),
    }
}

pub(super) fn stream_params(container: &str, tty: bool, interactive: bool) -> AttachParams {
    AttachParams::default()
        .container(container)
        .stdin(interactive)
        .stdout(true)
        // The API refuses stderr next to a TTY, where both come through one stream.
        .stderr(!tty)
        .tty(tty)
        .max_stdin_buf_size(STREAM_BUFFER)
        .max_stdout_buf_size(STREAM_BUFFER)
        .max_stderr_buf_size(STREAM_BUFFER)
}

/// How the session ended, from the status the API server sends at the end.
fn event_from_status(status: Option<Status>) -> SessionEvent {
    let Some(status) = status else {
        return SessionEvent::Exited { code: None };
    };
    if status.status.as_deref() == Some("Success") {
        return SessionEvent::Exited { code: Some(0) };
    }
    let exit_code = status
        .details
        .as_ref()
        .and_then(|details| details.causes.as_ref())
        .and_then(|causes| {
            causes
                .iter()
                .find(|cause| cause.reason.as_deref() == Some("ExitCode"))
        })
        .and_then(|cause| cause.message.as_deref())
        .and_then(|message| message.parse::<u32>().ok());
    match exit_code {
        Some(code) if status.reason.as_deref() == Some("NonZeroExitCode") => {
            SessionEvent::Exited { code: Some(code) }
        }
        _ => SessionEvent::Failed {
            error: IpcError::new(
                ErrorCode::Internal,
                status
                    .message
                    .unwrap_or_else(|| "the session ended with an error".to_owned()),
            ),
            pod_events: Vec::new(),
        },
    }
}

fn remote_size(size: TerminalSize) -> RemoteSize {
    RemoteSize {
        width: size.cols,
        height: size.rows,
    }
}

/// Copies one output stream until it ends. While flow control has it paused, the
/// connection's own buffers fill and the API server stops sending.
async fn pump_output(
    mut stream: impl AsyncRead + Unpin,
    flow: Arc<FlowControl>,
    output: mpsc::Sender<SessionOutput>,
    token: CancellationToken,
) {
    let mut chunk = vec![0; READ_CHUNK];
    loop {
        tokio::select! {
            () = token.cancelled() => return,
            () = flow.ready() => {}
        }
        let read = tokio::select! {
            () = token.cancelled() => return,
            read = stream.read(&mut chunk) => read,
        };
        let count = match read {
            Ok(0) | Err(_) => return,
            Ok(count) => count,
        };
        flow.sent(count as u64);
        if output
            .send(SessionOutput::Data(chunk[..count].to_vec()))
            .await
            .is_err()
        {
            token.cancel();
            return;
        }
    }
}

async fn pump_input(
    mut stream: impl AsyncWrite + Unpin,
    mut input: mpsc::Receiver<Vec<u8>>,
    token: CancellationToken,
) {
    loop {
        let data = tokio::select! {
            () = token.cancelled() => return,
            data = input.recv() => data,
        };
        let Some(data) = data else {
            return;
        };
        if stream.write_all(&data).await.is_err() || stream.flush().await.is_err() {
            return;
        }
    }
}

async fn pump_resize(
    mut sizes: futures::channel::mpsc::Sender<RemoteSize>,
    initial: TerminalSize,
    mut resize: watch::Receiver<TerminalSize>,
    token: CancellationToken,
) {
    // A shell starts at the API server's default until it is told otherwise.
    if sizes.send(remote_size(initial)).await.is_err() {
        return;
    }
    loop {
        tokio::select! {
            () = token.cancelled() => return,
            changed = resize.changed() => {
                if changed.is_err() {
                    return;
                }
            }
        }
        let size = *resize.borrow_and_update();
        if sizes.send(remote_size(size)).await.is_err() {
            return;
        }
    }
}

/// What a running exec or attach connection needs.
pub(super) struct RemoteStreams {
    pub(super) size: TerminalSize,
    pub(super) flow: Arc<FlowControl>,
    pub(super) input: Option<mpsc::Receiver<Vec<u8>>>,
    pub(super) resize: watch::Receiver<TerminalSize>,
    pub(super) output: mpsc::Sender<SessionOutput>,
    pub(super) token: CancellationToken,
}

impl RemoteStreams {
    pub(super) fn new(
        size: TerminalSize,
        interactive: bool,
        output: mpsc::Sender<SessionOutput>,
        token: CancellationToken,
    ) -> (Self, TerminalControl) {
        let flow = Arc::new(FlowControl::new());
        let (resize_tx, resize) = watch::channel(size);
        let (input_tx, input) = if interactive {
            let (tx, rx) = mpsc::channel(INPUT_BACKLOG);
            (Some(tx), Some(rx))
        } else {
            (None, None)
        };
        let streams = RemoteStreams {
            size,
            flow: flow.clone(),
            input,
            resize,
            output,
            token,
        };
        let control = TerminalControl {
            input: input_tx,
            resize: resize_tx,
            flow,
        };
        (streams, control)
    }
}

/// Runs a connected process until its output ends or the session stops, and returns the
/// session's last event.
pub(super) async fn run_process(
    mut process: AttachedProcess,
    streams: RemoteStreams,
) -> SessionEvent {
    let RemoteStreams {
        size,
        flow,
        input,
        resize,
        output,
        token,
    } = streams;
    let status = process.take_status();
    // Ends the helper tasks when the output has ended, however that came about.
    let helpers = token.child_token();
    let mut tasks = JoinSet::new();
    if let (Some(stdin), Some(input)) = (process.stdin(), input) {
        tasks.spawn(pump_input(stdin, input, helpers.clone()));
    }
    if let Some(sizes) = process.terminal_size() {
        tasks.spawn(pump_resize(sizes, size, resize, helpers.clone()));
    }
    let out = process.stdout();
    let err = process.stderr();
    let pump_out = async {
        if let Some(stream) = out {
            pump_output(stream, flow.clone(), output.clone(), token.clone()).await;
        }
    };
    let pump_err = async {
        if let Some(stream) = err {
            pump_output(stream, flow.clone(), output.clone(), token.clone()).await;
        }
    };
    tokio::join!(pump_out, pump_err);
    helpers.cancel();
    while tasks.join_next().await.is_some() {}
    if token.is_cancelled() {
        process.abort();
        return SessionEvent::Exited { code: None };
    }
    let status = match status {
        Some(status) => tokio::time::timeout(STATUS_LIMIT, status)
            .await
            .unwrap_or(None),
        None => None,
    };
    event_from_status(status)
}

/// Which API a session connects through.
enum RemoteKind {
    Shell,
    Attach,
}

async fn connect(
    pods: &Api<Pod>,
    pod: &str,
    kind: &RemoteKind,
    params: &AttachParams,
) -> Result<AttachedProcess, kube::Error> {
    match kind {
        RemoteKind::Shell => pods.exec(pod, SHELL, params).await,
        RemoteKind::Attach => pods.attach(pod, params).await,
    }
}

fn check_names(namespace: &str, pod: &str, container: Option<&str>) -> CoreResult<()> {
    let valid = [Some(namespace), Some(pod), container]
        .into_iter()
        .flatten()
        .all(is_path_segment);
    if valid {
        Ok(())
    } else {
        Err(invalid("the namespace, pod or container name is not valid"))
    }
}

struct RemoteRequest {
    kind: RemoteKind,
    namespace: String,
    pod: String,
    container: String,
    tty: bool,
    interactive: bool,
    size: TerminalSize,
}

impl AppCore {
    /// The stopping and reporting every remote session shares. Runs without a session until
    /// the pod has been read, so a pod that cannot be read rejects the command.
    fn spawn_remote(
        &self,
        id: &ClusterId,
        request: RemoteRequest,
        output: mpsc::Sender<SessionOutput>,
    ) -> CoreResult<String> {
        let client = self.cluster_client(id)?;
        let token = self.cluster_cancel_token(id)?;
        let (streams, control) = RemoteStreams::new(
            request.size,
            request.interactive,
            output.clone(),
            token.clone(),
        );
        let guard = self.sessions().register(token.clone(), Some(control));
        let session = guard.id().to_owned();
        tokio::spawn(async move {
            let pods: Api<Pod> = Api::namespaced(client, &request.namespace);
            let params = stream_params(&request.container, request.tty, request.interactive);
            let connected = tokio::select! {
                () = token.cancelled() => None,
                connected = connect(&pods, &request.pod, &request.kind, &params) => Some(connected),
            };
            let last = match connected {
                None => SessionEvent::Exited { code: None },
                Some(Err(error)) => SessionEvent::Failed {
                    error: error.into(),
                    pod_events: Vec::new(),
                },
                Some(Ok(process)) => {
                    let started = SessionEvent::Started {
                        tty: request.interactive,
                    };
                    let _ = output.send(SessionOutput::Event(started)).await;
                    run_process(process, streams).await
                }
            };
            let _ = output.send(SessionOutput::Event(last)).await;
            drop(guard);
        });
        Ok(session)
    }

    /// Starts a shell in a container. `container: None` picks the default one (F12).
    pub async fn pod_exec_start(
        &self,
        id: &ClusterId,
        namespace: &str,
        pod: &str,
        container: Option<String>,
        size: TerminalSize,
        output: mpsc::Sender<SessionOutput>,
    ) -> CoreResult<String> {
        check_names(namespace, pod, container.as_deref())?;
        let client = self.cluster_client(id)?;
        let object = read_pod(&client, namespace, pod).await?;
        let container = choose_container(&object, container)?;
        let request = RemoteRequest {
            kind: RemoteKind::Shell,
            namespace: namespace.to_owned(),
            pod: pod.to_owned(),
            container,
            tty: true,
            interactive: true,
            size,
        };
        self.spawn_remote(id, request, output)
    }

    /// Attaches to a container's main process. With no TTY in its spec the session is output
    /// only, which `Started { tty: false }` tells the interface.
    pub async fn pod_attach_start(
        &self,
        id: &ClusterId,
        namespace: &str,
        pod: &str,
        container: Option<String>,
        size: TerminalSize,
        output: mpsc::Sender<SessionOutput>,
    ) -> CoreResult<String> {
        check_names(namespace, pod, container.as_deref())?;
        let client = self.cluster_client(id)?;
        let object = read_pod(&client, namespace, pod).await?;
        let container = choose_container(&object, container)?;
        let mode = declared_container(&object, &container).map_or(
            AttachMode {
                tty: false,
                interactive: false,
            },
            attach_mode,
        );
        let request = RemoteRequest {
            kind: RemoteKind::Attach,
            namespace: namespace.to_owned(),
            pod: pod.to_owned(),
            container,
            tty: mode.tty,
            interactive: mode.interactive,
            size,
        };
        self.spawn_remote(id, request, output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::{StatusCause, StatusDetails};
    use serde_json::json;

    fn pod(annotation: Option<&str>) -> Value {
        let mut object = json!({
            "metadata": { "annotations": {} },
            "spec": {
                "initContainers": [{ "name": "setup" }],
                "containers": [{ "name": "first" }, { "name": "second" }],
            },
        });
        if let Some(name) = annotation {
            object["metadata"]["annotations"][DEFAULT_CONTAINER] = json!(name);
        }
        object
    }

    #[test]
    fn the_annotation_names_the_default_container_if_the_pod_declares_it() {
        assert_eq!(default_container(&pod(Some("second"))).unwrap(), "second");
        assert_eq!(default_container(&pod(Some("missing"))).unwrap(), "first");
        assert_eq!(default_container(&pod(None)).unwrap(), "first");
    }

    #[test]
    fn an_explicit_container_wins_and_must_be_declared() {
        assert_eq!(
            choose_container(&pod(Some("second")), Some("setup".into())).unwrap(),
            "setup"
        );
        let error = choose_container(&pod(None), Some("other".into())).unwrap_err();
        assert_eq!(error.code, ErrorCode::NotFound);
        let error = choose_container(&json!({ "spec": {} }), None).unwrap_err();
        assert_eq!(error.code, ErrorCode::NotFound);
    }

    #[test]
    fn input_needs_both_a_tty_and_stdin() {
        let mode = |container: Value| attach_mode(&container);
        assert_eq!(
            mode(json!({ "tty": true, "stdin": true })),
            AttachMode {
                tty: true,
                interactive: true
            }
        );
        assert_eq!(
            mode(json!({ "tty": true })),
            AttachMode {
                tty: true,
                interactive: false
            }
        );
        assert_eq!(
            mode(json!({ "stdin": true })),
            AttachMode {
                tty: false,
                interactive: false
            }
        );
    }

    #[test]
    fn stderr_is_asked_for_only_without_a_tty() {
        let with_tty = stream_params("c", true, true);
        assert!(with_tty.tty && with_tty.stdin && !with_tty.stderr);
        let without = stream_params("c", false, false);
        assert!(!without.tty && !without.stdin && without.stderr && without.stdout);
        assert_eq!(without.container.as_deref(), Some("c"));
    }

    fn exit_status(reason: &str, cause_reason: &str, message: &str) -> Status {
        Status {
            status: Some("Failure".into()),
            reason: Some(reason.into()),
            message: Some("command terminated".into()),
            details: Some(StatusDetails {
                causes: Some(vec![StatusCause {
                    reason: Some(cause_reason.into()),
                    message: Some(message.into()),
                    ..StatusCause::default()
                }]),
                ..StatusDetails::default()
            }),
            ..Status::default()
        }
    }

    #[test]
    fn success_and_a_non_zero_exit_become_exit_codes() {
        let success = Status {
            status: Some("Success".into()),
            ..Status::default()
        };
        assert!(matches!(
            event_from_status(Some(success)),
            SessionEvent::Exited { code: Some(0) }
        ));
        assert!(matches!(
            event_from_status(Some(exit_status("NonZeroExitCode", "ExitCode", "3"))),
            SessionEvent::Exited { code: Some(3) }
        ));
    }

    #[test]
    fn no_status_is_an_unknown_exit_and_any_other_is_a_failure() {
        assert!(matches!(
            event_from_status(None),
            SessionEvent::Exited { code: None }
        ));
        let other = exit_status("InternalError", "Other", "x");
        let SessionEvent::Failed { error, .. } = event_from_status(Some(other)) else {
            panic!("not a failure");
        };
        assert_eq!(error.message, "command terminated");
    }

    #[test]
    fn names_that_are_not_path_segments_are_refused() {
        assert!(check_names("default", "pod", Some("c")).is_ok());
        assert!(check_names("default", "a/b", None).is_err());
        assert!(check_names("..", "pod", None).is_err());
        assert!(check_names("default", "pod", Some("a/b")).is_err());
    }
}
