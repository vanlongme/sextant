//! Node drain against the fake API server.
//! Every kubeconfig lives in a temp `<home>/.kube`; `KUBECONFIG` is never read.

use std::time::{Duration, Instant};

use k8s_openapi::api::core::v1::Pod;
use kube::Api;
use serde_json::{json, Value};
use sextant_core::app_core::AppCore;
use sextant_core::cluster::ConnectionState;
use sextant_core::error::ErrorCode;
use sextant_core::kubeconfig::ClusterId;
use sextant_core::paths::AppPaths;
use sextant_core::resources::{DrainEvent, DrainOptions, DrainOutcome};
use sextant_fakekube::{DenyRule, FakeKube, FakeKubeConfig, FakeResource};
use tempfile::TempDir;
use tokio::sync::mpsc;

const CONTEXT: &str = "fake";
const NO_OPTIONS: DrainOptions = DrainOptions {
    force: false,
    delete_empty_dir: false,
    timeout_seconds: None,
};
const LIMIT: Duration = Duration::from_secs(30);
const EVICTION_OF_A: &str = "/api/v1/namespaces/default/pods/a/eviction";
const DAEMON_SET_UID: &str = "daemon-set-uid";
const FORCE: DrainOptions = DrainOptions {
    force: true,
    delete_empty_dir: false,
    timeout_seconds: None,
};

async fn connected(cfg: FakeKubeConfig) -> (AppCore, FakeKube, ClusterId, TempDir) {
    let fake = FakeKube::start(cfg).await.unwrap();
    let root = tempfile::tempdir().unwrap();
    let kube_dir = root.path().join("home").join(".kube");
    std::fs::create_dir_all(&kube_dir).unwrap();
    fake.write_kubeconfig(&kube_dir.join("config"), CONTEXT)
        .unwrap();
    let paths = AppPaths::under(&root.path().join("app"), &root.path().join("home"));
    let core = AppCore::start_with_kubeconfig_env(paths, None)
        .await
        .unwrap();
    let started = Instant::now();
    let id = loop {
        let found = core
            .catalog_list()
            .into_iter()
            .find(|entry| entry.context_name == CONTEXT);
        if let Some(entry) = found {
            break entry.id;
        }
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "timed out waiting for the catalog entry"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    let state = core.cluster_connect(&id).await.unwrap();
    assert!(
        matches!(state, ConnectionState::Connected { .. }),
        "{state:?}"
    );
    (core, fake, id, root)
}

async fn fake_with_node(cfg: FakeKubeConfig) -> (AppCore, FakeKube, ClusterId, TempDir) {
    let (core, fake, id, root) = connected(cfg).await;
    fake.upsert("nodes", json!({ "metadata": { "name": "n1" } }));
    (core, fake, id, root)
}

fn pod_on(fake: &FakeKube, node: &str, name: &str, owners: Value) {
    fake.upsert(
        "pods",
        json!({
            "metadata": { "name": name, "namespace": "default", "ownerReferences": owners },
            "spec": { "nodeName": node },
            "status": { "phase": "Running" },
        }),
    );
}

fn managed_pod(fake: &FakeKube, name: &str) {
    let owner = json!([{ "apiVersion": "apps/v1", "kind": "ReplicaSet", "name": "rs", "uid": "u", "controller": true }]);
    pod_on(fake, "n1", name, owner);
}

fn serve_daemon_sets(fake: &FakeKube) {
    fake.serve_resource(FakeResource::new(
        "apps",
        "v1",
        "DaemonSet",
        "daemonsets",
        true,
    ));
}

fn daemon_set(fake: &FakeKube) {
    fake.upsert(
        "daemonsets",
        json!({ "metadata": { "name": "ds", "namespace": "default", "uid": DAEMON_SET_UID } }),
    );
}

/// Pod `a`, naming DaemonSet `ds` with this uid as its controller.
fn daemon_pod(fake: &FakeKube, owner_uid: &str) {
    let owner = json!([{ "apiVersion": "apps/v1", "kind": "DaemonSet", "name": "ds", "uid": owner_uid, "controller": true }]);
    pod_on(fake, "n1", "a", owner);
}

/// Receives until an event matches, and returns everything received so far.
async fn wait_until(
    rx: &mut mpsc::Receiver<DrainEvent>,
    done: impl Fn(&DrainEvent) -> bool,
) -> Vec<DrainEvent> {
    let mut events = Vec::new();
    tokio::time::timeout(LIMIT, async {
        while let Some(event) = rx.recv().await {
            let stop = done(&event);
            events.push(event);
            if stop {
                return;
            }
        }
    })
    .await
    .expect("the awaited event never came");
    events
}

async fn collect(rx: &mut mpsc::Receiver<DrainEvent>) -> Vec<DrainEvent> {
    wait_until(rx, |e| matches!(e, DrainEvent::Finished { .. })).await
}

fn outcome(events: &[DrainEvent]) -> (&DrainOutcome, &str) {
    match events.last() {
        Some(DrainEvent::Finished { outcome, message }) => {
            (outcome, message.as_deref().unwrap_or_default())
        }
        other => panic!("no Finished event: {other:?}"),
    }
}

async fn start(
    core: &AppCore,
    id: &ClusterId,
    options: DrainOptions,
) -> (String, mpsc::Receiver<DrainEvent>) {
    let (tx, rx) = mpsc::channel(32);
    let drain = core.node_drain_start(id, "n1", options, tx).await.unwrap();
    (drain, rx)
}

#[tokio::test]
async fn drain_cordons_then_evicts_and_finishes() {
    let (core, fake, id, _root) = fake_with_node(FakeKubeConfig::default()).await;
    managed_pod(&fake, "a");
    let (_drain, mut rx) = start(&core, &id, NO_OPTIONS).await;
    let events = collect(&mut rx).await;
    assert!(matches!(events[0], DrainEvent::Cordoned));
    assert!(matches!(events[1], DrainEvent::Planned { .. }));
    assert_eq!(*outcome(&events).0, DrainOutcome::Completed);
    assert_eq!(
        fake.writes("PATCH", "/api/v1/nodes/n1")[0].body,
        json!({ "spec": { "unschedulable": true } })
    );
    assert_eq!(fake.writes("POST", EVICTION_OF_A).len(), 1);
}

#[tokio::test]
async fn drain_only_touches_pods_on_that_node() {
    let (core, fake, id, _root) = fake_with_node(FakeKubeConfig::default()).await;
    pod_on(
        &fake,
        "n2",
        "elsewhere",
        json!([{ "kind": "ReplicaSet", "name": "rs", "uid": "u", "controller": true }]),
    );
    let (_drain, mut rx) = start(&core, &id, NO_OPTIONS).await;
    assert_eq!(*outcome(&collect(&mut rx).await).0, DrainOutcome::Completed);
    assert!(fake
        .writes("POST", "/api/v1/namespaces/default/pods/elsewhere/eviction")
        .is_empty());
}

#[tokio::test]
async fn drain_refuses_blocking_pods_and_leaves_the_node_cordoned() {
    let (core, fake, id, _root) = fake_with_node(FakeKubeConfig::default()).await;
    managed_pod(&fake, "a");
    pod_on(&fake, "n1", "lonely", json!([]));
    let (_drain, mut rx) = start(&core, &id, NO_OPTIONS).await;
    let events = collect(&mut rx).await;
    let (result, message) = outcome(&events);
    assert_eq!(*result, DrainOutcome::Refused);
    assert!(message.contains("default/lonely"), "{message}");
    assert!(fake.writes("POST", EVICTION_OF_A).is_empty());
    assert!(fake
        .writes("POST", "/api/v1/namespaces/default/pods/lonely/eviction")
        .is_empty());
    // The cordon stays, as kubectl leaves it.
    assert_eq!(fake.writes("PATCH", "/api/v1/nodes/n1").len(), 1);
}

#[tokio::test]
async fn drain_retries_on_429_and_reports_blocked() {
    let (core, fake, id, _root) = fake_with_node(FakeKubeConfig::default()).await;
    managed_pod(&fake, "a");
    fake.fail_evictions_with("default", "a", 429, Some(1));
    let started = Instant::now();
    let (_drain, mut rx) = start(&core, &id, NO_OPTIONS).await;
    let events = collect(&mut rx).await;
    let blocked = events.iter().find_map(|e| match e {
        DrainEvent::PodBlocked { message, .. } => Some(message),
        _ => None,
    });
    assert!(blocked
        .expect("no PodBlocked")
        .contains("disruption budget"));
    assert!(events
        .iter()
        .any(|e| matches!(e, DrainEvent::PodGone { .. })));
    assert_eq!(*outcome(&events).0, DrainOutcome::Completed);
    assert_eq!(fake.writes("POST", EVICTION_OF_A).len(), 2);
    assert!(started.elapsed() >= Duration::from_secs(5));
}

#[tokio::test]
async fn drain_waits_until_the_pod_is_gone() {
    let (core, fake, id, _root) = fake_with_node(FakeKubeConfig::default()).await;
    managed_pod(&fake, "a");
    fake.hold_evicted_pods(true);
    let (_drain, mut rx) = start(&core, &id, NO_OPTIONS).await;
    let early = tokio::time::timeout(Duration::from_secs(2), async {
        while let Some(event) = rx.recv().await {
            if matches!(
                event,
                DrainEvent::PodGone { .. } | DrainEvent::Finished { .. }
            ) {
                return;
            }
        }
    })
    .await;
    assert!(early.is_err(), "the drain did not wait for the pod");
    fake.delete_pod("default", "a");
    assert_eq!(*outcome(&collect(&mut rx).await).0, DrainOutcome::Completed);
}

#[tokio::test]
async fn a_pod_recreated_with_a_new_uid_counts_as_gone() {
    let (core, fake, id, _root) = fake_with_node(FakeKubeConfig::default()).await;
    managed_pod(&fake, "a");
    fake.hold_evicted_pods(true);
    let (_drain, mut rx) = start(&core, &id, NO_OPTIONS).await;
    wait_until(&mut rx, |e| matches!(e, DrainEvent::PodEvicting { .. })).await;
    fake.delete_pod("default", "a");
    managed_pod(&fake, "a");
    assert_eq!(*outcome(&collect(&mut rx).await).0, DrainOutcome::Completed);
}

#[tokio::test]
async fn a_retry_does_not_evict_a_pod_recreated_under_the_same_name() {
    let (core, fake, id, _root) = fake_with_node(FakeKubeConfig::default()).await;
    managed_pod(&fake, "a");
    fake.fail_evictions_with("default", "a", 429, Some(1));
    let (_drain, mut rx) = start(&core, &id, NO_OPTIONS).await;
    wait_until(&mut rx, |e| matches!(e, DrainEvent::PodBlocked { .. })).await;
    fake.delete_pod("default", "a");
    managed_pod(&fake, "a");
    assert_eq!(*outcome(&collect(&mut rx).await).0, DrainOutcome::Completed);
    let pods: Api<Pod> = Api::namespaced(core.cluster_client(&id).unwrap(), "default");
    assert!(
        pods.get_opt("a").await.unwrap().is_some(),
        "the replacement was evicted"
    );
}

#[tokio::test]
async fn a_conflict_on_a_pod_that_is_still_there_fails_it() {
    let (core, fake, id, _root) = fake_with_node(FakeKubeConfig::default()).await;
    managed_pod(&fake, "a");
    fake.fail_evictions_with("default", "a", 409, None);
    let (_drain, mut rx) = start(&core, &id, NO_OPTIONS).await;
    let events = collect(&mut rx).await;
    let (result, message) = outcome(&events);
    assert_eq!(*result, DrainOutcome::Failed);
    assert!(message.contains("default/a"), "{message}");
}

#[tokio::test]
async fn a_pod_of_a_live_daemon_set_is_skipped() {
    let (core, fake, id, _root) = fake_with_node(FakeKubeConfig::default()).await;
    serve_daemon_sets(&fake);
    daemon_set(&fake);
    daemon_pod(&fake, DAEMON_SET_UID);
    let (_drain, mut rx) = start(&core, &id, FORCE).await;
    let events = collect(&mut rx).await;
    assert_eq!(*outcome(&events).0, DrainOutcome::Completed);
    assert!(events
        .iter()
        .any(|e| matches!(e, DrainEvent::Planned { skipped, .. } if skipped.len() == 1)));
    assert!(fake.writes("POST", EVICTION_OF_A).is_empty());
}

#[tokio::test]
async fn a_pod_whose_daemon_set_is_missing_refuses_the_drain() {
    let (core, fake, id, _root) = fake_with_node(FakeKubeConfig::default()).await;
    serve_daemon_sets(&fake);
    daemon_pod(&fake, DAEMON_SET_UID);
    let (_drain, mut rx) = start(&core, &id, NO_OPTIONS).await;
    let events = collect(&mut rx).await;
    let (result, message) = outcome(&events);
    assert_eq!(*result, DrainOutcome::Refused);
    assert!(message.contains("default/a"), "{message}");
    assert!(fake.writes("POST", EVICTION_OF_A).is_empty());
}

#[tokio::test]
async fn force_evicts_a_pod_whose_daemon_set_is_missing() {
    let (core, fake, id, _root) = fake_with_node(FakeKubeConfig::default()).await;
    serve_daemon_sets(&fake);
    daemon_pod(&fake, DAEMON_SET_UID);
    let (_drain, mut rx) = start(&core, &id, FORCE).await;
    assert_eq!(*outcome(&collect(&mut rx).await).0, DrainOutcome::Completed);
    assert_eq!(fake.writes("POST", EVICTION_OF_A).len(), 1);
}

#[tokio::test]
async fn a_daemon_set_with_another_uid_does_not_protect_the_pod() {
    let (core, fake, id, _root) = fake_with_node(FakeKubeConfig::default()).await;
    serve_daemon_sets(&fake);
    daemon_set(&fake);
    daemon_pod(&fake, "forged");
    let (_drain, mut rx) = start(&core, &id, NO_OPTIONS).await;
    assert_eq!(*outcome(&collect(&mut rx).await).0, DrainOutcome::Refused);
    assert!(fake.writes("POST", EVICTION_OF_A).is_empty());
}

#[tokio::test]
async fn a_daemon_set_that_cannot_be_read_refuses_the_drain_even_with_force() {
    let rule = DenyRule {
        verb: "get".into(),
        plural: "daemonsets".into(),
        namespace: None,
    };
    let (core, fake, id, _root) = fake_with_node(FakeKubeConfig {
        deny: vec![rule],
        ..Default::default()
    })
    .await;
    serve_daemon_sets(&fake);
    daemon_set(&fake);
    daemon_pod(&fake, DAEMON_SET_UID);
    let (_drain, mut rx) = start(&core, &id, FORCE).await;
    let events = collect(&mut rx).await;
    let (result, message) = outcome(&events);
    assert_eq!(*result, DrainOutcome::Refused);
    assert!(message.contains("forbidden"), "{message}");
    assert!(fake.writes("POST", EVICTION_OF_A).is_empty());
}

#[tokio::test]
async fn drain_times_out() {
    let (core, fake, id, _root) = fake_with_node(FakeKubeConfig::default()).await;
    managed_pod(&fake, "a");
    fake.fail_evictions_with("default", "a", 429, None);
    let options = DrainOptions {
        timeout_seconds: Some(1),
        ..NO_OPTIONS
    };
    let (_drain, mut rx) = start(&core, &id, options).await;
    let events = collect(&mut rx).await;
    let (result, message) = outcome(&events);
    assert_eq!(*result, DrainOutcome::TimedOut);
    assert!(message.contains("default/a"), "{message}");
}

#[tokio::test]
async fn drain_can_be_cancelled() {
    let (core, fake, id, _root) = fake_with_node(FakeKubeConfig::default()).await;
    managed_pod(&fake, "a");
    fake.fail_evictions_with("default", "a", 429, None);
    let (drain, mut rx) = start(&core, &id, NO_OPTIONS).await;
    wait_until(&mut rx, |e| matches!(e, DrainEvent::PodBlocked { .. })).await;
    core.node_drain_cancel(&drain);
    assert_eq!(*outcome(&collect(&mut rx).await).0, DrainOutcome::Cancelled);
}

#[tokio::test]
async fn drain_stops_when_the_cluster_disconnects() {
    let (core, fake, id, _root) = fake_with_node(FakeKubeConfig::default()).await;
    managed_pod(&fake, "a");
    fake.fail_evictions_with("default", "a", 429, None);
    let (_drain, mut rx) = start(&core, &id, NO_OPTIONS).await;
    wait_until(&mut rx, |e| matches!(e, DrainEvent::PodBlocked { .. })).await;
    core.cluster_disconnect(&id).await.unwrap();
    assert_eq!(*outcome(&collect(&mut rx).await).0, DrainOutcome::Cancelled);
    let closed = tokio::time::timeout(LIMIT, rx.recv()).await.unwrap();
    assert!(closed.is_none());
}

#[tokio::test]
async fn a_forbidden_cordon_reports_the_api_message() {
    let rule = DenyRule {
        verb: "patch".into(),
        plural: "nodes".into(),
        namespace: None,
    };
    let (core, _fake, id, _root) = fake_with_node(FakeKubeConfig {
        deny: vec![rule],
        ..Default::default()
    })
    .await;
    let (_drain, mut rx) = start(&core, &id, NO_OPTIONS).await;
    let events = collect(&mut rx).await;
    assert!(!events.iter().any(|e| matches!(e, DrainEvent::Cordoned)));
    let (result, message) = outcome(&events);
    assert_eq!(*result, DrainOutcome::Failed);
    assert!(message.contains("forbidden"), "{message}");
}

#[tokio::test]
async fn a_second_drain_of_a_node_is_refused() {
    let (core, fake, id, _root) = fake_with_node(FakeKubeConfig::default()).await;
    managed_pod(&fake, "a");
    fake.fail_evictions_with("default", "a", 429, None);
    let (drain, mut rx) = start(&core, &id, NO_OPTIONS).await;
    let (tx, _second) = mpsc::channel(32);
    let error = core
        .node_drain_start(&id, "n1", NO_OPTIONS, tx)
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict);
    core.node_drain_cancel(&drain);
    collect(&mut rx).await;
    // The drain that finished frees the node.
    let (_again, _rx) = start(&core, &id, NO_OPTIONS).await;
}

#[tokio::test]
async fn a_failed_eviction_fails_the_drain_but_finishes_the_rest() {
    let (core, fake, id, _root) = fake_with_node(FakeKubeConfig::default()).await;
    managed_pod(&fake, "a");
    managed_pod(&fake, "b");
    fake.fail_evictions_with("default", "a", 500, None);
    let (_drain, mut rx) = start(&core, &id, NO_OPTIONS).await;
    let events = collect(&mut rx).await;
    assert!(events
        .iter()
        .any(|e| matches!(e, DrainEvent::PodFailed { pod, .. } if pod.name == "a")));
    assert!(events
        .iter()
        .any(|e| matches!(e, DrainEvent::PodGone { pod } if pod.name == "b")));
    let (result, message) = outcome(&events);
    assert_eq!(*result, DrainOutcome::Failed);
    assert!(message.contains("default/a"), "{message}");
}

#[tokio::test]
async fn closing_the_event_channel_cancels_the_drain() {
    let (core, fake, id, _root) = fake_with_node(FakeKubeConfig::default()).await;
    managed_pod(&fake, "a");
    fake.fail_evictions_with("default", "a", 429, None);
    let (_drain, mut rx) = start(&core, &id, NO_OPTIONS).await;
    wait_until(&mut rx, |e| matches!(e, DrainEvent::PodBlocked { .. })).await;
    drop(rx);
    // The node is free again once the run has noticed.
    let started = Instant::now();
    let (_again, _rx) = loop {
        let (tx, rx) = mpsc::channel(32);
        match core.node_drain_start(&id, "n1", NO_OPTIONS, tx).await {
            Ok(drain) => break (drain, rx),
            Err(error) => assert_eq!(error.code, ErrorCode::Conflict),
        }
        assert!(started.elapsed() < LIMIT, "the drain kept running");
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
}

#[tokio::test]
async fn cancelling_all_stops_every_drain_and_frees_their_nodes() {
    let (core, fake, id, _root) = fake_with_node(FakeKubeConfig::default()).await;
    fake.upsert("nodes", json!({ "metadata": { "name": "n2" } }));
    let owner = json!([{ "kind": "ReplicaSet", "name": "rs", "uid": "u", "controller": true }]);
    pod_on(&fake, "n1", "a", owner.clone());
    pod_on(&fake, "n2", "b", owner);
    fake.fail_evictions_with("default", "a", 429, None);
    fake.fail_evictions_with("default", "b", 429, None);
    let (_first, mut first_rx) = start(&core, &id, NO_OPTIONS).await;
    let (tx, mut second_rx) = mpsc::channel(32);
    core.node_drain_start(&id, "n2", NO_OPTIONS, tx)
        .await
        .unwrap();
    wait_until(&mut first_rx, |e| {
        matches!(e, DrainEvent::PodBlocked { .. })
    })
    .await;
    wait_until(&mut second_rx, |e| {
        matches!(e, DrainEvent::PodBlocked { .. })
    })
    .await;

    core.node_drain_cancel_all();

    let first = collect(&mut first_rx).await;
    let second = collect(&mut second_rx).await;
    assert_eq!(*outcome(&first).0, DrainOutcome::Cancelled);
    assert_eq!(*outcome(&second).0, DrainOutcome::Cancelled);
    // The connection survives, so the node can be drained again.
    let (_again, _rx) = start(&core, &id, NO_OPTIONS).await;
}

#[tokio::test]
async fn cancelling_all_with_nothing_running_changes_nothing() {
    let (core, fake, id, _root) = fake_with_node(FakeKubeConfig::default()).await;
    managed_pod(&fake, "a");
    core.node_drain_cancel_all();
    let (_drain, mut rx) = start(&core, &id, NO_OPTIONS).await;
    assert_eq!(*outcome(&collect(&mut rx).await).0, DrainOutcome::Completed);
}

#[tokio::test]
async fn an_invalid_node_name_is_refused() {
    let (core, _fake, id, _root) = fake_with_node(FakeKubeConfig::default()).await;
    let (tx, _rx) = mpsc::channel(32);
    let error = core
        .node_drain_start(&id, "../n1", NO_OPTIONS, tx)
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
}
