//! The node shell (F12): a privileged pod pinned to the node, entered through `nsenter`.
//!
//! The pod must not outlive the session. Every way out deletes it, naming its uid so that a
//! pod created later under the same name is left alone. A crash leaves it to its
//! `activeDeadlineSeconds`. The session's guard is held until the delete has finished, so
//! app quit waits for it.

use std::time::Duration;

use k8s_openapi::api::core::v1::{Node, Pod};
use kube::api::{DeleteParams, PostParams, Preconditions};
use kube::{Api, Client};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use super::exec::{run_process, stream_params, RemoteStreams};
use super::{random_hex, read_pod, SessionEvent, SessionOutput, TerminalSize};
use crate::app_core::AppCore;
use crate::error::{sanitize_text, CoreResult, ErrorCode, IpcError};
use crate::kubeconfig::ClusterId;
use crate::resources::{invalid, is_path_segment, InvolvedRef};

const NAMESPACE: &str = "kube-system";
const CONTAINER: &str = "shell";
const LABEL: &str = "skopos.dev/node-shell";
const OS_LABEL: &str = "kubernetes.io/os";
const DEFAULT_IMAGE: &str = "alpine:3.22";
const DEADLINE_SECONDS: i64 = 86_400;
pub(super) const START_LIMIT: Duration = Duration::from_secs(60);
const POLL: Duration = Duration::from_secs(1);
const DELETE_ATTEMPTS: u32 = 3;
const DELETE_PAUSE: Duration = Duration::from_secs(1);
/// Enters the namespaces of the node's PID 1, then starts the best shell the node has.
const NSENTER: [&str; 11] = [
    "nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--", "sh", "-c",
];
const LOGIN_SHELL: &str =
    "if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi";

fn pod_name() -> String {
    format!("skopos-node-shell-{}", &random_hex()[..8])
}

fn pod_manifest(name: &str, node: &str, image: &str) -> Value {
    json!({
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {
            "name": name,
            "namespace": NAMESPACE,
            "labels": { LABEL: "true" },
        },
        "spec": {
            "nodeName": node,
            "restartPolicy": "Never",
            "terminationGracePeriodSeconds": 0,
            "activeDeadlineSeconds": DEADLINE_SECONDS,
            "hostPID": true,
            "hostNetwork": true,
            "priorityClassName": "system-node-critical",
            "tolerations": [{ "operator": "Exists" }],
            "containers": [{
                "name": CONTAINER,
                "image": image,
                "command": ["sleep", DEADLINE_SECONDS.to_string()],
                "securityContext": { "privileged": true },
            }],
        },
    })
}

fn is_windows_node(node: &Node) -> bool {
    node.metadata
        .labels
        .as_ref()
        .and_then(|labels| labels.get(OS_LABEL))
        .is_some_and(|os| os == "windows")
}

fn is_node_shell_pod(pod: &Value) -> bool {
    pod.pointer("/metadata/labels")
        .and_then(|labels| labels.get(LABEL))
        .and_then(Value::as_str)
        == Some("true")
}

/// `reason: message`, the way a user reads events.
fn format_event(event: &Value) -> String {
    let field = |name: &str| event.get(name).and_then(Value::as_str).unwrap_or_default();
    sanitize_text(&format!("{}: {}", field("reason"), field("message")))
}

/// Deletes the pod with this uid. Gone or replaced, it is no longer ours to delete.
async fn delete_pod(client: &Client, name: &str, uid: &str) {
    let pods: Api<Pod> = Api::namespaced(client.clone(), NAMESPACE);
    let params = DeleteParams::default().preconditions(Preconditions {
        uid: Some(uid.to_owned()),
        resource_version: None,
    });
    for attempt in 1..=DELETE_ATTEMPTS {
        match pods.delete(name, &params).await {
            Ok(_) => return,
            Err(kube::Error::Api(status)) if matches!(status.code, 404 | 409) => return,
            Err(_) if attempt < DELETE_ATTEMPTS => tokio::time::sleep(DELETE_PAUSE).await,
            Err(_) => {}
        }
    }
    tracing::warn!(
        pod = name,
        "a node shell pod could not be deleted; its deadline will end it"
    );
}

/// After a create that did not answer: it may still have worked. The name is random, so a
/// pod under it with our label is ours.
async fn clean_after_failed_create(client: &Client, name: &str) {
    let Ok(pod) = read_pod(client, NAMESPACE, name).await else {
        return;
    };
    if !is_node_shell_pod(&pod) {
        return;
    }
    if let Some(uid) = pod.pointer("/metadata/uid").and_then(Value::as_str) {
        delete_pod(client, name, uid).await;
    }
}

enum WaitEnd {
    Running,
    Stopped,
    Failed(IpcError),
}

fn start_timeout(limit: Duration) -> IpcError {
    IpcError::new(
        ErrorCode::Internal,
        format!(
            "the node shell pod did not start within {} seconds",
            limit.as_secs()
        ),
    )
}

/// Waits for the phase `Running`, on the pod with this uid and no other.
async fn wait_until_running(
    client: &Client,
    name: &str,
    uid: &str,
    limit: Duration,
    token: &CancellationToken,
) -> WaitEnd {
    let deadline = Instant::now() + limit;
    loop {
        match read_pod(client, NAMESPACE, name).await {
            Ok(pod) => {
                if pod.pointer("/metadata/uid").and_then(Value::as_str) != Some(uid) {
                    return WaitEnd::Failed(IpcError::new(
                        ErrorCode::Conflict,
                        "the node shell pod was replaced",
                    ));
                }
                match pod.pointer("/status/phase").and_then(Value::as_str) {
                    Some("Running") => return WaitEnd::Running,
                    Some(phase @ ("Succeeded" | "Failed")) => {
                        return WaitEnd::Failed(IpcError::new(
                            ErrorCode::Internal,
                            format!("the node shell pod ended in phase {phase}"),
                        ));
                    }
                    _ => {}
                }
            }
            Err(kube::Error::Api(status)) if status.code == 404 => {
                return WaitEnd::Failed(IpcError::new(
                    ErrorCode::NotFound,
                    "the node shell pod was deleted",
                ));
            }
            // Passing trouble. The deadline ends this if it does not pass.
            Err(_) => {}
        }
        let now = Instant::now();
        if now >= deadline {
            return WaitEnd::Failed(start_timeout(limit));
        }
        tokio::select! {
            () = token.cancelled() => return WaitEnd::Stopped,
            () = tokio::time::sleep_until((now + POLL).min(deadline)) => {}
        }
    }
}

/// Everything the task needs once the pod exists.
struct CreatedPod {
    core: AppCore,
    id: ClusterId,
    client: Client,
    name: String,
    uid: String,
    limit: Duration,
    output: mpsc::Sender<SessionOutput>,
    token: CancellationToken,
}

impl CreatedPod {
    async fn status(&self, message: &str) {
        let event = SessionEvent::Status {
            message: message.to_owned(),
        };
        let _ = self.output.send(SessionOutput::Event(event)).await;
    }

    async fn events(&self) -> Vec<String> {
        let involved = InvolvedRef {
            kind: "Pod".to_owned(),
            namespace: Some(NAMESPACE.to_owned()),
            name: self.name.clone(),
            uid: Some(self.uid.clone()),
        };
        self.core
            .resource_events(&self.id, &involved)
            .await
            .map(|events| events.iter().map(format_event).collect())
            .unwrap_or_default()
    }

    /// Waits for the pod and runs the shell. Returns the session's last event.
    async fn run(&self, streams: RemoteStreams) -> SessionEvent {
        self.status("Waiting for the node shell pod to start").await;
        let waited =
            wait_until_running(&self.client, &self.name, &self.uid, self.limit, &self.token).await;
        match waited {
            WaitEnd::Running => {}
            WaitEnd::Stopped => return SessionEvent::Exited { code: None },
            WaitEnd::Failed(error) => {
                return SessionEvent::Failed {
                    error,
                    pod_events: self.events().await,
                };
            }
        }
        self.status("Connecting to the node").await;
        let pods: Api<Pod> = Api::namespaced(self.client.clone(), NAMESPACE);
        let mut command: Vec<&str> = NSENTER.to_vec();
        command.push(LOGIN_SHELL);
        let params = stream_params(CONTAINER, true, true);
        let connected = tokio::select! {
            () = self.token.cancelled() => None,
            connected = pods.exec(&self.name, command, &params) => Some(connected),
        };
        match connected {
            None => SessionEvent::Exited { code: None },
            Some(Err(error)) => SessionEvent::Failed {
                error: error.into(),
                pod_events: self.events().await,
            },
            Some(Ok(process)) => {
                let started = SessionEvent::Started { tty: true };
                let _ = self.output.send(SessionOutput::Event(started)).await;
                run_process(process, streams).await
            }
        }
    }
}

impl AppCore {
    /// Starts a shell on a node. A Windows node is refused before any pod is created.
    /// Progress arrives as `Status` events.
    pub async fn node_shell_start(
        &self,
        id: &ClusterId,
        node: &str,
        size: TerminalSize,
        output: mpsc::Sender<SessionOutput>,
    ) -> CoreResult<String> {
        if !is_path_segment(node) {
            return Err(invalid("the node name is not valid"));
        }
        let client = self.cluster_client(id)?;
        let nodes: Api<Node> = Api::all(client.clone());
        if is_windows_node(&nodes.get(node).await?) {
            return Err(invalid("the node shell is not supported on Windows nodes"));
        }
        let token = self.cluster_cancel_token(id)?;
        let settings = self.cluster_settings_get(id);
        let image = settings
            .node_shell_image
            .filter(|image| !image.is_empty())
            .unwrap_or_else(|| DEFAULT_IMAGE.to_owned());
        let name = pod_name();
        let manifest: Pod = serde_json::from_value(pod_manifest(&name, node, &image))
            .map_err(|error| IpcError::new(ErrorCode::Internal, error.to_string()))?;
        let (streams, control) = RemoteStreams::new(size, true, output.clone(), token.clone());
        let guard = self.sessions().register(token.clone(), Some(control));
        let session = guard.id().to_owned();
        let core = self.clone();
        let id = id.clone();
        let limit = self.sessions().node_shell_limit();
        tokio::spawn(async move {
            let pods: Api<Pod> = Api::namespaced(client.clone(), NAMESPACE);
            let creating = SessionEvent::Status {
                message: format!("Creating pod {name}"),
            };
            let _ = output.send(SessionOutput::Event(creating)).await;
            // Not raced against the token: dropping a create on the wire could leave a pod
            // nobody knows about, so a stop waits for its answer and then deletes.
            let created = pods.create(&PostParams::default(), &manifest).await;
            let uid = match created {
                Ok(pod) => pod.metadata.uid,
                Err(error) => {
                    // An answer from the API server means nothing was created.
                    if !matches!(error, kube::Error::Api(_)) {
                        clean_after_failed_create(&client, &name).await;
                    }
                    let failed = SessionEvent::Failed {
                        error: error.into(),
                        pod_events: Vec::new(),
                    };
                    let _ = output.send(SessionOutput::Event(failed)).await;
                    drop(guard);
                    return;
                }
            };
            let Some(uid) = uid else {
                clean_after_failed_create(&client, &name).await;
                let failed = SessionEvent::Failed {
                    error: IpcError::new(ErrorCode::Internal, "the created pod has no uid"),
                    pod_events: Vec::new(),
                };
                let _ = output.send(SessionOutput::Event(failed)).await;
                drop(guard);
                return;
            };
            let created = CreatedPod {
                core,
                id,
                client: client.clone(),
                name: name.clone(),
                uid: uid.clone(),
                limit,
                output: output.clone(),
                token,
            };
            let last = created.run(streams).await;
            let _ = output.send(SessionOutput::Event(last)).await;
            delete_pod(&client, &name, &uid).await;
            drop(guard);
        });
        Ok(session)
    }

    /// Shortens the wait for the node shell pod in tests.
    pub fn set_node_shell_start_limit_for_test(&self, limit: Duration) {
        self.sessions().set_node_shell_limit(limit);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kube::config::{KubeConfigOptions, Kubeconfig};
    use kube::Config;
    use skopos_fakekube::{FakeKube, FakeKubeConfig};

    #[test]
    fn the_name_has_the_prefix_and_eight_hex_digits() {
        let name = pod_name();
        let (prefix, digits) = name.rsplit_once('-').unwrap();
        assert_eq!(prefix, "skopos-node-shell");
        assert_eq!(digits.len(), 8);
        assert!(digits.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn the_manifest_is_what_f12_asks_for() {
        let pod = pod_manifest("n", "worker", "img:1");
        assert_eq!(pod["metadata"]["namespace"], "kube-system");
        assert_eq!(pod["metadata"]["labels"]["skopos.dev/node-shell"], "true");
        let spec = &pod["spec"];
        assert_eq!(spec["nodeName"], "worker");
        assert_eq!(spec["restartPolicy"], "Never");
        assert_eq!(spec["activeDeadlineSeconds"], 86_400);
        assert_eq!(spec["hostPID"], true);
        assert_eq!(spec["hostNetwork"], true);
        assert_eq!(spec["tolerations"], json!([{ "operator": "Exists" }]));
        let container = &spec["containers"][0];
        assert_eq!(container["image"], "img:1");
        assert_eq!(container["securityContext"]["privileged"], true);
        // The typed form must keep all of it.
        let typed: Pod = serde_json::from_value(pod.clone()).unwrap();
        assert_eq!(serde_json::to_value(&typed).unwrap()["spec"], pod["spec"]);
    }

    #[test]
    fn events_read_as_reason_and_message() {
        let event = json!({ "reason": "Failed", "message": "no such image" });
        assert_eq!(format_event(&event), "Failed: no such image");
    }

    async fn fake_client(fake: &FakeKube, dir: &std::path::Path) -> Client {
        let path = dir.join("config");
        fake.write_kubeconfig(&path, "fake").unwrap();
        let kubeconfig = Kubeconfig::read_from(&path).unwrap();
        let options = KubeConfigOptions {
            context: Some("fake".into()),
            ..Default::default()
        };
        let config = Config::from_custom_kubeconfig(kubeconfig, &options)
            .await
            .unwrap();
        Client::try_from(config).unwrap()
    }

    #[tokio::test]
    async fn after_a_failed_create_only_a_labelled_pod_is_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let fake = FakeKube::start(FakeKubeConfig::default()).await.unwrap();
        let client = fake_client(&fake, dir.path()).await;
        fake.upsert("pods", pod_manifest("ours", "worker", "img:1"));
        fake.add_pod(NAMESPACE, "theirs");

        clean_after_failed_create(&client, "ours").await;
        clean_after_failed_create(&client, "theirs").await;
        clean_after_failed_create(&client, "never-created").await;

        assert!(read_pod(&client, NAMESPACE, "ours").await.is_err());
        assert!(read_pod(&client, NAMESPACE, "theirs").await.is_ok());
    }
}
