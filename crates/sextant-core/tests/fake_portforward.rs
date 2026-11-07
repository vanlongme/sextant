//! Port-forward definitions and status against the fake API server. The fake has no
//! port-forward route, because a fake of that protocol would test itself. Data goes through
//! a real one in `kind_portforward.rs`.

mod support;

use std::time::Duration;

use serde_json::json;
use sextant_core::app_core::{AppCore, CoreEvent};
use sextant_core::error::ErrorCode;
use sextant_core::kubeconfig::ClusterId;
use sextant_core::paths::AppPaths;
use sextant_core::portforward::{
    PortForward, PortForwardKind, PortForwardPort, PortForwardSpec, PortForwardState,
    PortForwardTarget,
};
use sextant_fakekube::FakeKubeConfig;
use support::connected_fake;
use tokio::net::{TcpListener, TcpStream};

const LIMIT: Duration = Duration::from_secs(30);

fn pod_spec(id: &ClusterId, local_port: Option<u16>) -> PortForwardSpec {
    PortForwardSpec {
        cluster_id: id.clone(),
        target: PortForwardTarget {
            kind: PortForwardKind::Pod,
            namespace: "default".into(),
            name: "p".into(),
        },
        target_port: PortForwardPort::Number(8080),
        local_port,
    }
}

fn state_of(core: &AppCore, id: &str) -> PortForward {
    core.portforward_list()
        .into_iter()
        .find(|forward| forward.id == id)
        .unwrap()
}

async fn wait_until(core: &AppCore, id: &str, done: impl Fn(&PortForward) -> bool) -> PortForward {
    tokio::time::timeout(LIMIT, async {
        loop {
            let forward = state_of(core, id);
            if done(&forward) {
                return forward;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the awaited state never came")
}

#[tokio::test]
async fn adding_does_not_start_it_and_definitions_survive_a_restart() {
    let (core, _fake, id, root) = connected_fake(FakeKubeConfig::default()).await;
    let added = core.portforward_add(pod_spec(&id, Some(18080))).unwrap();
    assert_eq!(added.state, PortForwardState::Stopped);
    assert_eq!(added.bound_port, None);
    assert_eq!(core.portforward_list(), std::slice::from_ref(&added));
    core.shutdown().await;

    let paths = AppPaths::under(&root.path().join("app"), &root.path().join("home"));
    let reopened = AppCore::start_with_kubeconfig_env(paths, None)
        .await
        .unwrap();
    let listed = reopened.portforward_list();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, added.id);
    assert_eq!(listed[0].spec, added.spec);
    assert_eq!(listed[0].state, PortForwardState::Stopped);
    reopened.shutdown().await;
}

#[tokio::test]
async fn invalid_specs_are_refused() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    let error = core.portforward_add(pod_spec(&id, Some(0))).unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
    assert!(core.portforward_list().is_empty());
}

#[tokio::test]
async fn a_random_port_is_bound_on_loopback_and_repeat_calls_are_safe() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.add_pod("default", "p");
    let added = core.portforward_add(pod_spec(&id, None)).unwrap();
    let running = core.portforward_start(&added.id).await.unwrap();
    assert_eq!(running.state, PortForwardState::Running);
    let port = running.bound_port.unwrap();
    assert_ne!(port, 0);
    assert!(TcpStream::connect(("127.0.0.1", port)).await.is_ok());

    // Starting again returns the one that runs.
    let again = core.portforward_start(&added.id).await.unwrap();
    assert_eq!(again.bound_port, Some(port));

    core.portforward_stop(&added.id).await;
    core.portforward_stop(&added.id).await;
    let stopped = state_of(&core, &added.id);
    assert_eq!(stopped.state, PortForwardState::Stopped);
    assert_eq!(stopped.bound_port, None);
    // Stopping let go of the port.
    assert!(TcpListener::bind(("127.0.0.1", port)).await.is_ok());

    core.portforward_remove(&added.id).await.unwrap();
    core.portforward_remove(&added.id).await.unwrap();
    assert!(core.portforward_list().is_empty());
    core.portforward_stop("pf-unknown").await;
}

#[tokio::test]
async fn a_stopped_forward_can_start_again_on_the_same_port() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.add_pod("default", "p");
    let free = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = free.local_addr().unwrap().port();
    drop(free);
    let added = core.portforward_add(pod_spec(&id, Some(port))).unwrap();
    for _ in 0..3 {
        let running = core.portforward_start(&added.id).await.unwrap();
        assert_eq!(running.bound_port, Some(port));
        core.portforward_stop(&added.id).await;
    }
}

#[tokio::test]
async fn a_taken_port_fails_with_invalid_input_naming_the_port() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.add_pod("default", "p");
    let holder = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = holder.local_addr().unwrap().port();
    let added = core.portforward_add(pod_spec(&id, Some(port))).unwrap();
    let error = core.portforward_start(&added.id).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
    assert!(
        error.message.contains(&port.to_string()),
        "{}",
        error.message
    );
    let failed = state_of(&core, &added.id);
    assert_eq!(failed.state, PortForwardState::Failed);
    assert_eq!(failed.message.as_deref(), Some(error.message.as_str()));

    drop(holder);
    assert!(core.portforward_start(&added.id).await.is_ok());
}

#[tokio::test]
async fn a_missing_target_rejects_and_the_forward_shows_failed() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    let added = core.portforward_add(pod_spec(&id, None)).unwrap();
    let error = core.portforward_start(&added.id).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::NotFound);
    assert_eq!(state_of(&core, &added.id).state, PortForwardState::Failed);
}

#[tokio::test]
async fn starting_an_unknown_id_is_not_found() {
    let (core, _fake, _id, _root) = connected_fake(FakeKubeConfig::default()).await;
    let error = core.portforward_start("pf-unknown").await.unwrap_err();
    assert_eq!(error.code, ErrorCode::NotFound);
}

#[tokio::test]
async fn a_failing_connection_sets_the_message_and_the_forward_keeps_running() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.add_pod("default", "p");
    let added = core.portforward_add(pod_spec(&id, None)).unwrap();
    let running = core.portforward_start(&added.id).await.unwrap();
    let _socket = TcpStream::connect(("127.0.0.1", running.bound_port.unwrap()))
        .await
        .unwrap();
    let after = wait_until(&core, &added.id, |forward| forward.message.is_some()).await;
    assert_eq!(after.state, PortForwardState::Running);
    assert_eq!(after.active_connections, 0);
}

#[tokio::test]
async fn a_page_load_leaves_forwards_running_and_disconnect_stops_them() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.add_pod("default", "p");
    let added = core.portforward_add(pod_spec(&id, None)).unwrap();
    let port = core
        .portforward_start(&added.id)
        .await
        .unwrap()
        .bound_port
        .unwrap();

    // What the `on_page_load` hook calls.
    core.sessions_stop_all();
    assert!(core.sessions_wait_idle(LIMIT).await);
    assert_eq!(state_of(&core, &added.id).state, PortForwardState::Running);

    core.cluster_disconnect(&id).await.unwrap();
    wait_until(&core, &added.id, |forward| {
        forward.state == PortForwardState::Stopped
    })
    .await;
    assert!(TcpStream::connect(("127.0.0.1", port)).await.is_err());
}

#[tokio::test]
async fn starting_on_a_disconnected_cluster_is_refused() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    let added = core.portforward_add(pod_spec(&id, None)).unwrap();
    core.cluster_disconnect(&id).await.unwrap();
    let error = core.portforward_start(&added.id).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::Unreachable);
}

#[tokio::test]
async fn changes_are_published() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.add_pod("default", "p");
    let mut events = core.subscribe();
    let added = core.portforward_add(pod_spec(&id, None)).unwrap();
    core.portforward_start(&added.id).await.unwrap();
    let mut seen = Vec::new();
    tokio::time::timeout(LIMIT, async {
        while !seen.contains(&PortForwardState::Running) {
            if let CoreEvent::PortForwardsChanged { forwards } = events.recv().await.unwrap() {
                if let Some(forward) = forwards.first() {
                    seen.push(forward.state);
                }
            }
        }
    })
    .await
    .expect("no running state was published");
    assert!(seen.contains(&PortForwardState::Starting), "{seen:?}");
    let value = serde_json::to_value(CoreEvent::PortForwardsChanged { forwards: vec![] }).unwrap();
    assert_eq!(
        value,
        json!({ "type": "portForwardsChanged", "forwards": [] })
    );
}
