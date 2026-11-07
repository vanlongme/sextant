//! The node shell against the real `skopos-e2e` kind cluster.
//! Needs `make test-kind`. Only `e2e/.tmp/kubeconfig` is read, never a default one.

mod support;

use std::time::Duration;

use k8s_openapi::api::core::v1::Pod;
use kube::api::ListParams;
use kube::{Api, Client};
use skopos_core::app_core::AppCore;
use skopos_core::kubeconfig::ClusterId;
use skopos_core::prefs::ClusterSettings;
use skopos_core::sessions::{SessionEvent, SessionOutput, TerminalSize};
use support::connected_kind;
use tokio::sync::mpsc;

const WAIT: Duration = Duration::from_secs(180);
const WORKER: &str = "skopos-e2e-worker";
const SIZE: TerminalSize = TerminalSize {
    cols: 120,
    rows: 40,
};

async fn shell_pod_count(client: &Client) -> usize {
    let pods: Api<Pod> = Api::namespaced(client.clone(), "kube-system");
    let params = ListParams::default().labels("skopos.dev/node-shell=true");
    pods.list(&params).await.unwrap().items.len()
}

async fn wait_for_started(core: &AppCore, session: &str, rx: &mut mpsc::Receiver<SessionOutput>) {
    let mut statuses = 0;
    tokio::time::timeout(WAIT, async {
        loop {
            match rx.recv().await {
                Some(SessionOutput::Event(SessionEvent::Status { .. })) => statuses += 1,
                Some(SessionOutput::Event(SessionEvent::Started { tty })) => {
                    assert!(tty);
                    assert!(statuses >= 2, "{statuses} status events");
                    return;
                }
                Some(SessionOutput::Data(data)) => core.session_ack(session, data.len() as u64),
                other => panic!("{other:?}"),
            }
        }
    })
    .await
    .expect("the shell never started");
}

async fn wait_for_text(
    core: &AppCore,
    session: &str,
    rx: &mut mpsc::Receiver<SessionOutput>,
    wanted: &str,
) {
    let mut text = String::new();
    tokio::time::timeout(WAIT, async {
        while !text.contains(wanted) {
            match rx.recv().await {
                Some(SessionOutput::Data(data)) => {
                    core.session_ack(session, data.len() as u64);
                    text.push_str(&String::from_utf8_lossy(&data));
                }
                Some(_) => {}
                None => panic!("the session ended before {wanted:?}: {text}"),
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{wanted:?} never came: {text}"));
}

fn client_of(core: &AppCore, id: &ClusterId) -> Client {
    core.cluster_client(id).unwrap()
}

#[tokio::test]
#[ignore = "needs the skopos-e2e kind cluster"]
async fn the_shell_runs_on_the_node_and_stopping_deletes_the_pod() {
    let (core, id, _root) = connected_kind().await;
    let client = client_of(&core, &id);
    let (tx, mut rx) = mpsc::channel(32);
    let session = core.node_shell_start(&id, WORKER, SIZE, tx).await.unwrap();
    wait_for_started(&core, &session, &mut rx).await;
    assert_eq!(shell_pod_count(&client).await, 1);
    core.session_write(&session, b"echo host=$(cat /etc/hostname)\r".to_vec())
        .unwrap();
    wait_for_text(&core, &session, &mut rx, &format!("host={WORKER}")).await;
    core.session_stop(&session);
    assert!(core.sessions_wait_idle(WAIT).await);
    assert_eq!(shell_pod_count(&client).await, 0);
}

#[tokio::test]
#[ignore = "needs the skopos-e2e kind cluster"]
async fn an_image_that_cannot_be_pulled_fails_with_the_pods_events() {
    let (core, id, _root) = connected_kind().await;
    let client = client_of(&core, &id);
    core.cluster_settings_set(
        &id,
        ClusterSettings {
            node_shell_image: Some("registry.invalid/no-such-image:1".to_owned()),
            ..ClusterSettings::default()
        },
    )
    .unwrap();
    core.set_node_shell_start_limit_for_test(Duration::from_secs(15));
    let (tx, mut rx) = mpsc::channel(32);
    core.node_shell_start(&id, WORKER, SIZE, tx).await.unwrap();
    let last = tokio::time::timeout(WAIT, async {
        loop {
            match rx.recv().await {
                Some(SessionOutput::Event(event @ SessionEvent::Failed { .. })) => return event,
                Some(SessionOutput::Event(SessionEvent::Exited { code })) => {
                    panic!("exited: {code:?}")
                }
                Some(_) => {}
                None => panic!("the session ended without a failure"),
            }
        }
    })
    .await
    .expect("the session never failed");
    let SessionEvent::Failed { pod_events, .. } = last else {
        unreachable!();
    };
    assert!(!pod_events.is_empty());
    assert!(core.sessions_wait_idle(WAIT).await);
    assert_eq!(shell_pod_count(&client).await, 0);
}

#[tokio::test]
#[ignore = "needs the skopos-e2e kind cluster"]
async fn app_quit_leaves_no_pod_behind() {
    let (core, id, _root) = connected_kind().await;
    let client = client_of(&core, &id);
    let (tx, mut rx) = mpsc::channel(32);
    let session = core.node_shell_start(&id, WORKER, SIZE, tx).await.unwrap();
    wait_for_started(&core, &session, &mut rx).await;
    core.shutdown().await;
    assert_eq!(shell_pod_count(&client).await, 0);
}
