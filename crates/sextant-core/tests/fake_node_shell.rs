//! The node shell's pod handling against the fake API server. The shell itself needs a real
//! kubelet, so `kind_node_shell.rs` covers that.

mod support;

use std::time::Duration;

use k8s_openapi::api::core::v1::Pod;
use kube::api::ListParams;
use kube::{Api, Client};
use serde_json::{json, Value};
use sextant_core::app_core::AppCore;
use sextant_core::error::ErrorCode;
use sextant_core::kubeconfig::ClusterId;
use sextant_core::prefs::ClusterSettings;
use sextant_core::sessions::{SessionEvent, SessionOutput, TerminalSize};
use sextant_fakekube::{FakeKube, FakeKubeConfig};
use support::connected_fake;
use tokio::sync::mpsc;

const LIMIT: Duration = Duration::from_secs(30);
const NAMESPACE: &str = "kube-system";
const POD_PATH: &str = "/api/v1/namespaces/kube-system/pods";
const SIZE: TerminalSize = TerminalSize { cols: 80, rows: 24 };

fn add_node(fake: &FakeKube, os: &str) {
    fake.upsert(
        "nodes",
        json!({
            "metadata": { "name": "worker", "labels": { "kubernetes.io/os": os } },
        }),
    );
}

async fn start(core: &AppCore, id: &ClusterId) -> (String, mpsc::Receiver<SessionOutput>) {
    let (tx, rx) = mpsc::channel(32);
    let session = core.node_shell_start(id, "worker", SIZE, tx).await.unwrap();
    (session, rx)
}

async fn shell_pods(client: &Client) -> Vec<Pod> {
    let pods: Api<Pod> = Api::namespaced(client.clone(), NAMESPACE);
    let params = ListParams::default().labels("sextant.dev/node-shell=true");
    pods.list(&params).await.unwrap().items
}

/// Waits for the pod to exist, and returns its name and uid.
async fn wait_for_pod(client: &Client) -> (String, String) {
    tokio::time::timeout(LIMIT, async {
        loop {
            if let Some(pod) = shell_pods(client).await.pop() {
                return (pod.metadata.name.unwrap(), pod.metadata.uid.unwrap());
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the pod was never created")
}

async fn wait_for_last_event(rx: &mut mpsc::Receiver<SessionOutput>) -> SessionEvent {
    tokio::time::timeout(LIMIT, async {
        loop {
            match rx.recv().await {
                Some(SessionOutput::Event(
                    event @ (SessionEvent::Exited { .. } | SessionEvent::Failed { .. }),
                )) => {
                    return event;
                }
                Some(_) => {}
                None => panic!("the session ended without a last event"),
            }
        }
    })
    .await
    .expect("no last event")
}

fn pod_delete_body(fake: &FakeKube, name: &str) -> Value {
    let path = format!("{POD_PATH}/{name}");
    fake.writes("DELETE", &path)
        .pop()
        .unwrap_or_else(|| panic!("no DELETE of {path}"))
        .body
}

#[tokio::test]
async fn a_windows_node_is_refused_before_any_pod_is_created() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    add_node(&fake, "windows");
    let (tx, _rx) = mpsc::channel(4);
    let error = core
        .node_shell_start(&id, "worker", SIZE, tx)
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
    assert!(fake.writes("POST", POD_PATH).is_empty());
    assert_eq!(core.session_count(), 0);
}

#[tokio::test]
async fn a_missing_node_is_refused_with_the_api_server_message() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    let (tx, _rx) = mpsc::channel(4);
    let error = core
        .node_shell_start(&id, "worker", SIZE, tx)
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::NotFound);
    assert!(error.message.contains("worker"), "{}", error.message);
    assert!(fake.writes("POST", POD_PATH).is_empty());
}

#[tokio::test]
async fn the_pod_uses_the_default_image_or_the_clusters_setting() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    add_node(&fake, "linux");
    let client = core.cluster_client(&id).unwrap();

    let (session, mut rx) = start(&core, &id).await;
    wait_for_pod(&client).await;
    core.session_stop(&session);
    wait_for_last_event(&mut rx).await;
    assert!(core.sessions_wait_idle(LIMIT).await);

    core.cluster_settings_set(
        &id,
        ClusterSettings {
            node_shell_image: Some("example.test/shell:1".to_owned()),
            ..ClusterSettings::default()
        },
    )
    .unwrap();
    let (session, mut rx) = start(&core, &id).await;
    wait_for_pod(&client).await;
    core.session_stop(&session);
    wait_for_last_event(&mut rx).await;

    let posts = fake.writes("POST", POD_PATH);
    let image = |index: usize| posts[index].body["spec"]["containers"][0]["image"].clone();
    assert_eq!(image(0), "alpine:3.22");
    assert_eq!(image(1), "example.test/shell:1");
}

#[tokio::test]
async fn a_pod_that_does_not_start_fails_with_its_events_and_is_deleted_by_uid() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    add_node(&fake, "linux");
    core.set_node_shell_start_limit_for_test(Duration::from_secs(1));
    let client = core.cluster_client(&id).unwrap();
    let (_session, mut rx) = start(&core, &id).await;
    let (name, uid) = wait_for_pod(&client).await;
    fake.upsert(
        "events",
        json!({
            "metadata": { "name": "e1", "namespace": NAMESPACE },
            "involvedObject": { "kind": "Pod", "namespace": NAMESPACE, "name": name, "uid": uid },
            "reason": "FailedScheduling",
            "message": "no nodes available",
        }),
    );
    let SessionEvent::Failed { error, pod_events } = wait_for_last_event(&mut rx).await else {
        panic!("the session did not fail");
    };
    assert_eq!(error.code, ErrorCode::Internal);
    assert_eq!(pod_events, ["FailedScheduling: no nodes available"]);
    assert!(core.sessions_wait_idle(LIMIT).await);
    assert!(shell_pods(&client).await.is_empty());
    assert_eq!(pod_delete_body(&fake, &name)["preconditions"]["uid"], uid);
}

#[tokio::test]
async fn a_replacement_under_the_same_name_is_left_alone() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    add_node(&fake, "linux");
    let client = core.cluster_client(&id).unwrap();
    let (_session, mut rx) = start(&core, &id).await;
    let (name, uid) = wait_for_pod(&client).await;

    fake.delete_pod(NAMESPACE, &name);
    fake.upsert(
        "pods",
        json!({
            "metadata": {
                "name": name,
                "namespace": NAMESPACE,
                "labels": { "sextant.dev/node-shell": "true" },
            },
            "status": { "phase": "Running" },
        }),
    );

    let SessionEvent::Failed { error, .. } = wait_for_last_event(&mut rx).await else {
        panic!("the session did not fail");
    };
    assert_eq!(error.code, ErrorCode::Conflict);
    assert!(core.sessions_wait_idle(LIMIT).await);
    let left = shell_pods(&client).await;
    assert_eq!(left.len(), 1, "the replacement was deleted");
    assert_ne!(left[0].metadata.uid.as_deref(), Some(uid.as_str()));
    assert_eq!(pod_delete_body(&fake, &name)["preconditions"]["uid"], uid);
}

#[tokio::test]
async fn stopping_at_once_leaves_no_pod() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    add_node(&fake, "linux");
    let client = core.cluster_client(&id).unwrap();
    let (session, mut rx) = start(&core, &id).await;
    core.session_stop(&session);
    assert!(matches!(
        wait_for_last_event(&mut rx).await,
        SessionEvent::Exited { code: None }
    ));
    assert!(core.sessions_wait_idle(LIMIT).await);
    assert!(shell_pods(&client).await.is_empty());
}

#[tokio::test]
async fn a_shell_that_cannot_connect_fails_and_the_pod_is_deleted() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    add_node(&fake, "linux");
    let client = core.cluster_client(&id).unwrap();
    let (_session, mut rx) = start(&core, &id).await;
    let (name, _uid) = wait_for_pod(&client).await;
    // The fake has no exec route, as a failing connection would look.
    let mut pod = fake_pod_json(&client, &name).await;
    pod["status"] = json!({ "phase": "Running" });
    fake.upsert("pods", pod);
    assert!(matches!(
        wait_for_last_event(&mut rx).await,
        SessionEvent::Failed { .. }
    ));
    assert!(core.sessions_wait_idle(LIMIT).await);
    assert!(shell_pods(&client).await.is_empty());
}

async fn fake_pod_json(client: &Client, name: &str) -> Value {
    let pods: Api<Pod> = Api::namespaced(client.clone(), NAMESPACE);
    serde_json::to_value(pods.get(name).await.unwrap()).unwrap()
}

#[tokio::test]
async fn disconnecting_stops_the_session_and_still_deletes_the_pod() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    add_node(&fake, "linux");
    let client = core.cluster_client(&id).unwrap();
    let (_session, mut rx) = start(&core, &id).await;
    wait_for_pod(&client).await;
    core.cluster_disconnect(&id).await.unwrap();
    wait_for_last_event(&mut rx).await;
    assert!(core.sessions_wait_idle(LIMIT).await);
    assert!(shell_pods(&client).await.is_empty());
}

#[tokio::test]
async fn app_quit_waits_for_the_pod_to_go() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    add_node(&fake, "linux");
    let client = core.cluster_client(&id).unwrap();
    let (_session, _rx) = start(&core, &id).await;
    wait_for_pod(&client).await;
    core.shutdown().await;
    assert!(shell_pods(&client).await.is_empty());
}
