//! Logs, pod shell and attach against the real `sextant-e2e` kind cluster.
//! Needs `make test-kind`. Only `e2e/.tmp/kubeconfig` is read, never a default one.

mod support;

use std::time::Duration;

use k8s_openapi::api::apps::v1::StatefulSet;
use k8s_openapi::api::core::v1::Pod;
use kube::api::{DeleteParams, PostParams};
use kube::{Api, Client};
use serde_json::json;
use sextant_core::app_core::AppCore;
use sextant_core::error::ErrorCode;
use sextant_core::kubeconfig::ClusterId;
use sextant_core::resources::ResourceRef;
use sextant_core::sessions::{
    LogEvent, LogMarker, LogOptions, LogTarget, SessionEvent, SessionOutput, TerminalSize,
};
use support::{connected_kind, create_pod, in_namespace, wait_running, TEST_IMAGE};
use tokio::sync::mpsc;

const WAIT: Duration = Duration::from_secs(120);
const SIZE: TerminalSize = TerminalSize {
    cols: 120,
    rows: 40,
};

async fn kind_client() -> (AppCore, ClusterId, Client, tempfile::TempDir) {
    let (core, id, root) = connected_kind().await;
    let client = core.cluster_client(&id).unwrap();
    (core, id, client, root)
}

fn quiet_pod(name: &str) -> serde_json::Value {
    json!({
        "metadata": { "name": name },
        "spec": {
            "terminationGracePeriodSeconds": 0,
            "containers": [{ "name": "main", "image": TEST_IMAGE, "args": ["pause"] }],
        },
    })
}

fn printing_container(name: &str, script: &str) -> serde_json::Value {
    json!({ "name": name, "image": TEST_IMAGE, "command": ["/bin/sh", "-c", script] })
}

/// Reads and acknowledges output until it contains `wanted`.
async fn wait_for_text(
    core: &AppCore,
    session: &str,
    rx: &mut mpsc::Receiver<SessionOutput>,
    wanted: &str,
) -> String {
    let mut text = String::new();
    tokio::time::timeout(WAIT, async {
        while !text.contains(wanted) {
            match rx.recv().await {
                Some(SessionOutput::Data(data)) => {
                    core.session_ack(session, data.len() as u64);
                    text.push_str(&String::from_utf8_lossy(&data));
                }
                Some(SessionOutput::Event(SessionEvent::Failed { error, .. })) => {
                    panic!("failed: {error:?}")
                }
                Some(SessionOutput::Event(_)) => {}
                None => panic!("the session ended before {wanted:?}: {text}"),
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{wanted:?} never came: {text}"));
    text
}

async fn wait_for_event(
    core: &AppCore,
    session: &str,
    rx: &mut mpsc::Receiver<SessionOutput>,
) -> SessionEvent {
    tokio::time::timeout(WAIT, async {
        loop {
            match rx.recv().await {
                Some(SessionOutput::Data(data)) => core.session_ack(session, data.len() as u64),
                Some(SessionOutput::Event(event)) => return event,
                None => panic!("the session ended without an event"),
            }
        }
    })
    .await
    .expect("no event")
}

#[tokio::test]
#[ignore = "needs the sextant-e2e kind cluster"]
async fn pod_shell_runs_commands_resizes_and_reports_the_exit_code() {
    const NAMESPACE: &str = "sextant-test-sessions-shell";
    let (core, id, client, _root) = kind_client().await;
    in_namespace(&client, NAMESPACE, async {
        create_pod(&client, NAMESPACE, quiet_pod("shell")).await;
        wait_running(&client, NAMESPACE, "shell").await;
        let (tx, mut rx) = mpsc::channel(32);
        let session = core
            .pod_exec_start(&id, NAMESPACE, "shell", None, SIZE, tx)
            .await
            .unwrap();
        assert!(matches!(
            wait_for_event(&core, &session, &mut rx).await,
            SessionEvent::Started { tty: true }
        ));
        // The first size arrives with the connection.
        core.session_write(&session, b"stty size\r".to_vec())
            .unwrap();
        wait_for_text(&core, &session, &mut rx, "40 120").await;
        core.session_resize(&session, TerminalSize { cols: 91, rows: 37 });
        tokio::time::sleep(Duration::from_millis(300)).await;
        core.session_write(&session, b"stty size\r".to_vec())
            .unwrap();
        wait_for_text(&core, &session, &mut rx, "37 91").await;
        core.session_write(&session, b"exit 3\r".to_vec()).unwrap();
        assert!(matches!(
            wait_for_event(&core, &session, &mut rx).await,
            SessionEvent::Exited { code: Some(3) }
        ));
        assert!(core.sessions_wait_idle(WAIT).await);
    })
    .await;
}

#[tokio::test]
#[ignore = "needs the sextant-e2e kind cluster"]
async fn pod_shell_uses_the_default_container_annotation() {
    const NAMESPACE: &str = "sextant-test-sessions-default";
    let (core, id, client, _root) = kind_client().await;
    in_namespace(&client, NAMESPACE, async {
        let env = |value: &str| json!([{ "name": "WHICH", "value": value }]);
        let pod = json!({
            "metadata": {
                "name": "two",
                "annotations": { "kubectl.kubernetes.io/default-container": "second" },
            },
            "spec": {
                "terminationGracePeriodSeconds": 0,
                "containers": [
                    { "name": "first", "image": TEST_IMAGE, "args": ["pause"], "env": env("is-first") },
                    { "name": "second", "image": TEST_IMAGE, "args": ["pause"], "env": env("is-second") },
                ],
            },
        });
        create_pod(&client, NAMESPACE, pod).await;
        wait_running(&client, NAMESPACE, "two").await;
        let (tx, mut rx) = mpsc::channel(32);
        let session = core
            .pod_exec_start(&id, NAMESPACE, "two", None, SIZE, tx)
            .await
            .unwrap();
        core.session_write(&session, b"echo $WHICH\r".to_vec())
            .unwrap();
        wait_for_text(&core, &session, &mut rx, "is-second").await;
        core.session_stop(&session);
        assert!(core.sessions_wait_idle(WAIT).await);
    })
    .await;
}

#[tokio::test]
#[ignore = "needs the sextant-e2e kind cluster"]
async fn a_flood_in_a_pod_stops_at_the_limit_until_acknowledged() {
    const NAMESPACE: &str = "sextant-test-sessions-flood";
    let (core, id, client, _root) = kind_client().await;
    in_namespace(&client, NAMESPACE, async {
        create_pod(&client, NAMESPACE, quiet_pod("flood")).await;
        wait_running(&client, NAMESPACE, "flood").await;
        let (tx, mut rx) = mpsc::channel(32);
        let session = core
            .pod_exec_start(&id, NAMESPACE, "flood", None, SIZE, tx)
            .await
            .unwrap();
        core.session_write(&session, b"yes\r".to_vec()).unwrap();
        let mut unacked = 0;
        loop {
            let wait = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await;
            match wait {
                Ok(Some(SessionOutput::Data(data))) => {
                    unacked += data.len();
                    assert!(unacked <= 1024 * 1024 + 16 * 1024, "{unacked}");
                }
                Ok(Some(SessionOutput::Event(_))) => {}
                Ok(None) => panic!("the session ended"),
                Err(_) => break,
            }
        }
        assert!(unacked >= 512 * 1024, "stopped early, at {unacked}");
        core.session_ack(&session, unacked as u64);
        let more = tokio::time::timeout(WAIT, rx.recv()).await.unwrap();
        assert!(matches!(more, Some(SessionOutput::Data(_))));
        core.session_stop(&session);
        assert!(core.sessions_wait_idle(WAIT).await);
    })
    .await;
}

#[tokio::test]
#[ignore = "needs the sextant-e2e kind cluster"]
async fn attach_takes_input_only_when_the_container_has_a_tty_and_stdin() {
    const NAMESPACE: &str = "sextant-test-sessions-attach";
    let (core, id, client, _root) = kind_client().await;
    in_namespace(&client, NAMESPACE, async {
        let with_tty = json!({
            "metadata": { "name": "with-tty" },
            "spec": {
                "terminationGracePeriodSeconds": 0,
                "containers": [{
                    "name": "main", "image": TEST_IMAGE, "command": ["/bin/sh"],
                    "tty": true, "stdin": true,
                }],
            },
        });
        create_pod(&client, NAMESPACE, with_tty).await;
        wait_running(&client, NAMESPACE, "with-tty").await;
        let (tx, mut rx) = mpsc::channel(32);
        let session = core
            .pod_attach_start(&id, NAMESPACE, "with-tty", None, SIZE, tx)
            .await
            .unwrap();
        assert!(matches!(
            wait_for_event(&core, &session, &mut rx).await,
            SessionEvent::Started { tty: true }
        ));
        core.session_write(&session, b"echo $((6 * 7))\r".to_vec())
            .unwrap();
        wait_for_text(&core, &session, &mut rx, "42").await;
        core.session_stop(&session);
        assert!(core.sessions_wait_idle(WAIT).await);

        let without_tty = json!({
            "metadata": { "name": "no-tty" },
            "spec": {
                "terminationGracePeriodSeconds": 0,
                "containers": [printing_container(
                    "main",
                    "while true; do echo tick; echo tock >&2; sleep 0.2; done",
                )],
            },
        });
        create_pod(&client, NAMESPACE, without_tty).await;
        wait_running(&client, NAMESPACE, "no-tty").await;
        let (tx, mut rx) = mpsc::channel(32);
        let session = core
            .pod_attach_start(&id, NAMESPACE, "no-tty", None, SIZE, tx)
            .await
            .unwrap();
        assert!(matches!(
            wait_for_event(&core, &session, &mut rx).await,
            SessionEvent::Started { tty: false }
        ));
        // Both streams come through.
        wait_for_text(&core, &session, &mut rx, "tock").await;
        wait_for_text(&core, &session, &mut rx, "tick").await;
        let error = core.session_write(&session, b"x".to_vec()).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput);
        core.session_stop(&session);
        assert!(core.sessions_wait_idle(WAIT).await);
    })
    .await;
}

#[tokio::test]
#[ignore = "needs the sextant-e2e kind cluster"]
async fn a_shell_in_a_missing_pod_or_container_is_refused_with_the_reason() {
    const NAMESPACE: &str = "sextant-test-sessions-missing";
    let (core, id, client, _root) = kind_client().await;
    in_namespace(&client, NAMESPACE, async {
        let (tx, _rx) = mpsc::channel(4);
        let error = core
            .pod_exec_start(&id, NAMESPACE, "nope", None, SIZE, tx.clone())
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::NotFound);
        assert!(error.message.contains("nope"), "{}", error.message);

        create_pod(&client, NAMESPACE, quiet_pod("real")).await;
        let error = core
            .pod_exec_start(&id, NAMESPACE, "real", Some("other".into()), SIZE, tx)
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::NotFound);
        assert_eq!(core.session_count(), 0);
    })
    .await;
}

fn follow() -> LogOptions {
    LogOptions {
        follow: true,
        previous: false,
        tail_lines: Some(1000),
        since_seconds: None,
    }
}

async fn wait_for_log(
    rx: &mut mpsc::Receiver<LogEvent>,
    done: impl Fn(&LogEvent) -> bool,
) -> Vec<LogEvent> {
    let mut events = Vec::new();
    tokio::time::timeout(WAIT, async {
        while let Some(event) = rx.recv().await {
            let stop = done(&event);
            events.push(event);
            if stop {
                return;
            }
        }
        panic!("the session ended early: {events:?}");
    })
    .await
    .expect("the awaited event never came");
    events
}

fn has_text(event: &LogEvent, wanted: &str) -> bool {
    matches!(event, LogEvent::Lines { lines, .. } if lines.iter().any(|line| line.text.contains(wanted)))
}

fn has_marker(event: &LogEvent, wanted: LogMarker) -> bool {
    matches!(event, LogEvent::Marker { marker, .. } if *marker == wanted)
}

#[tokio::test]
#[ignore = "needs the sextant-e2e kind cluster"]
async fn real_logs_carry_timestamps_and_a_restart_shows_a_marker() {
    const NAMESPACE: &str = "sextant-test-sessions-logs";
    let (core, id, client, _root) = kind_client().await;
    in_namespace(&client, NAMESPACE, async {
        let pod = json!({
            "metadata": { "name": "restarts" },
            "spec": {
                "terminationGracePeriodSeconds": 0,
                "containers": [printing_container("main", "echo running; sleep 3; exit 1")],
            },
        });
        create_pod(&client, NAMESPACE, pod).await;
        let (tx, mut rx) = mpsc::channel(32);
        let target = LogTarget::Pod {
            namespace: NAMESPACE.into(),
            pod: "restarts".into(),
            container: None,
        };
        let session = core.logs_start(&id, target, follow(), tx).unwrap();
        let first = wait_for_log(&mut rx, |event| has_text(event, "running")).await;
        let line = first
            .iter()
            .find_map(|event| match event {
                LogEvent::Lines { lines, .. } => lines.first().cloned(),
                _ => None,
            })
            .unwrap();
        assert!(line.timestamp.is_some(), "{line:?}");
        assert_eq!(line.container, "main");
        wait_for_log(&mut rx, |event| has_marker(event, LogMarker::Restarted)).await;
        wait_for_log(&mut rx, |event| has_text(event, "running")).await;
        core.logs_stop(&session);
        assert!(core.sessions_wait_idle(WAIT).await);
    })
    .await;
}

#[tokio::test]
#[ignore = "needs the sextant-e2e kind cluster"]
async fn a_workload_stream_moves_to_the_pod_that_replaces_a_deleted_one() {
    const NAMESPACE: &str = "sextant-test-sessions-replace";
    let (core, id, client, _root) = kind_client().await;
    in_namespace(&client, NAMESPACE, async {
        let statefulset: StatefulSet = serde_json::from_value(json!({
            "metadata": { "name": "web" },
            "spec": {
                "serviceName": "web",
                "replicas": 1,
                "selector": { "matchLabels": { "app": "web" } },
                "template": {
                    "metadata": { "labels": { "app": "web" } },
                    "spec": {
                        "terminationGracePeriodSeconds": 0,
                        "containers": [printing_container(
                            "main",
                            "while true; do echo instance-$(cat /proc/sys/kernel/random/uuid); sleep 0.5; done",
                        )],
                    },
                },
            },
        }))
        .unwrap();
        let statefulsets: Api<StatefulSet> = Api::namespaced(client.clone(), NAMESPACE);
        statefulsets
            .create(&PostParams::default(), &statefulset)
            .await
            .unwrap();
        let target = LogTarget::Workload {
            resource: ResourceRef {
                group: "apps".into(),
                version: "v1".into(),
                plural: "statefulsets".into(),
                kind: "StatefulSet".into(),
                namespaced: true,
            },
            namespace: NAMESPACE.into(),
            name: "web".into(),
            container: None,
        };
        let (tx, mut rx) = mpsc::channel(32);
        let session = core.logs_start(&id, target, follow(), tx).unwrap();
        wait_for_log(&mut rx, |event| has_text(event, "instance-")).await;

        let pods: Api<Pod> = Api::namespaced(client.clone(), NAMESPACE);
        pods.delete("web-0", &DeleteParams::default()).await.unwrap();
        wait_for_log(&mut rx, |event| has_marker(event, LogMarker::PodRemoved)).await;
        wait_for_log(&mut rx, |event| has_marker(event, LogMarker::PodAdded)).await;
        wait_for_log(&mut rx, |event| has_text(event, "instance-")).await;
        core.logs_stop(&session);
        assert!(core.sessions_wait_idle(WAIT).await);
    })
    .await;
}
