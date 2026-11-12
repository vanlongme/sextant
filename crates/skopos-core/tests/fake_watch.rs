//! The watch hub against the fake API server.
//! Every kubeconfig lives in a temp `<home>/.kube`; `KUBECONFIG` is never read.

use std::collections::{BTreeMap, HashSet};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use skopos_core::app_core::AppCore;
use skopos_core::cluster::ConnectionState;
use skopos_core::kubeconfig::ClusterId;
use skopos_core::paths::AppPaths;
use skopos_core::resources::{ObjectKey, ResourceRef, Row, WatchEvent, WatchStatus};
use skopos_fakekube::{DenyRule, FakeKube, FakeKubeConfig, FakeResource};
use tempfile::TempDir;
use tokio::sync::mpsc;

const CONTEXT: &str = "fake";
const PODS: &str = "/api/v1/pods";
const WIDGETS: &str = "/apis/example.com/v1/widgets";
const WAIT: Duration = Duration::from_secs(10);
const QUIET: Duration = Duration::from_secs(2);
const FAST_BATCH: Duration = Duration::from_millis(20);
const LONG_LINGER: Duration = Duration::from_secs(30);

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
    core.set_watch_timing_for_test(FAST_BATCH, LONG_LINGER);
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

fn resource(group: &str, kind: &str, plural: &str, namespaced: bool) -> ResourceRef {
    ResourceRef {
        group: group.into(),
        version: "v1".into(),
        plural: plural.into(),
        kind: kind.into(),
        namespaced,
    }
}

fn pods() -> ResourceRef {
    resource("", "Pod", "pods", true)
}

fn secrets() -> ResourceRef {
    resource("", "Secret", "secrets", true)
}

fn widgets() -> ResourceRef {
    resource("example.com", "Widget", "widgets", true)
}

fn fake_widgets() -> FakeResource {
    FakeResource::new("example.com", "v1", "Widget", "widgets", true)
}

fn widget(name: &str) -> Value {
    json!({ "metadata": { "name": name, "namespace": "default" } })
}

fn deny_list(plural: &str) -> DenyRule {
    DenyRule {
        verb: "list".into(),
        plural: plural.into(),
        namespace: None,
    }
}

fn row_of(object: &Value) -> ObjectKey {
    ObjectKey {
        namespace: object
            .pointer("/metadata/namespace")
            .and_then(Value::as_str)
            .map(str::to_owned),
        name: object
            .pointer("/metadata/name")
            .and_then(Value::as_str)
            .unwrap()
            .to_owned(),
    }
}

fn key(namespace: &str, name: &str) -> ObjectKey {
    ObjectKey {
        namespace: Some(namespace.to_owned()),
        name: name.to_owned(),
    }
}

/// What a table does: applies the events to a local map of rows.
struct Consumer {
    id: String,
    rx: mpsc::Receiver<WatchEvent>,
    rows: BTreeMap<(Option<String>, String), Value>,
    seen: Vec<WatchEvent>,
}

impl Consumer {
    async fn subscribe(core: &AppCore, id: &ClusterId, resource: ResourceRef) -> Consumer {
        Self::with_capacity(core, id, resource, 64).await
    }

    async fn with_capacity(
        core: &AppCore,
        id: &ClusterId,
        resource: ResourceRef,
        capacity: usize,
    ) -> Consumer {
        let (tx, rx) = mpsc::channel(capacity);
        let id = core.resources_subscribe(id, resource, tx).await.unwrap();
        Consumer {
            id,
            rx,
            rows: BTreeMap::new(),
            seen: Vec::new(),
        }
    }

    fn take(&mut self, event: WatchEvent) {
        match &event {
            WatchEvent::Snapshot { items } => {
                self.rows.clear();
                for item in items.iter().map(Row::to_value) {
                    let row = row_of(&item);
                    self.rows.insert((row.namespace, row.name), item);
                }
            }
            WatchEvent::Batch { upserts, deletes } => {
                for item in upserts.iter().map(Row::to_value) {
                    let row = row_of(&item);
                    self.rows.insert((row.namespace, row.name), item);
                }
                for row in deletes {
                    self.rows.remove(&(row.namespace.clone(), row.name.clone()));
                }
            }
            WatchEvent::Status { .. } => {}
        }
        self.seen.push(event);
    }

    /// Receives until `done` holds.
    async fn until(&mut self, what: &str, done: impl Fn(&Consumer) -> bool) {
        let deadline = tokio::time::Instant::now() + WAIT;
        while !done(self) {
            match tokio::time::timeout_at(deadline, self.rx.recv()).await {
                Ok(Some(event)) => self.take(event),
                Ok(None) => panic!("closed before {what}; saw {}", self.summary()),
                Err(_) => panic!("timed out waiting for {what}; saw {}", self.summary()),
            }
        }
    }

    /// Receives whatever arrives during `span`.
    async fn drain_for(&mut self, span: Duration) {
        let deadline = tokio::time::Instant::now() + span;
        while let Ok(Some(event)) = tokio::time::timeout_at(deadline, self.rx.recv()).await {
            self.take(event);
        }
    }

    async fn until_closed(&mut self, what: &str, limit: Duration) {
        let deadline = tokio::time::Instant::now() + limit;
        loop {
            match tokio::time::timeout_at(deadline, self.rx.recv()).await {
                Ok(Some(event)) => self.take(event),
                Ok(None) => return,
                Err(_) => panic!("{what} did not close; saw {}", self.summary()),
            }
        }
    }

    fn snapshots(&self) -> usize {
        self.seen
            .iter()
            .filter(|e| matches!(e, WatchEvent::Snapshot { .. }))
            .count()
    }

    fn batches(&self) -> usize {
        self.seen
            .iter()
            .filter(|e| matches!(e, WatchEvent::Batch { .. }))
            .count()
    }

    fn saw_status(&self, status: WatchStatus) -> bool {
        self.status_message(status).is_some()
    }

    /// The message of the last event with this status. `Some("")` when it has none.
    fn status_message(&self, wanted: WatchStatus) -> Option<String> {
        self.seen.iter().rev().find_map(|event| match event {
            WatchEvent::Status { status, message } if *status == wanted => {
                Some(message.clone().unwrap_or_default())
            }
            _ => None,
        })
    }

    fn has(&self, namespace: &str, name: &str) -> bool {
        self.rows
            .contains_key(&(Some(namespace.to_owned()), name.to_owned()))
    }

    fn summary(&self) -> String {
        let events: Vec<String> = self
            .seen
            .iter()
            .map(|event| match event {
                WatchEvent::Snapshot { items } => format!("snapshot({})", items.len()),
                WatchEvent::Batch { upserts, deletes } => {
                    format!("batch(+{} -{})", upserts.len(), deletes.len())
                }
                WatchEvent::Status { status, .. } => format!("{status:?}"),
            })
            .collect();
        events.join(" ")
    }
}

async fn eventually(what: &str, done: impl Fn() -> bool) {
    let started = Instant::now();
    while !done() {
        assert!(started.elapsed() < WAIT, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn first_event_is_a_snapshot_then_batches_follow() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.add_pod("default", "one");
    fake.add_pod("default", "two");

    let mut pods = Consumer::subscribe(&core, &id, pods()).await;
    pods.until("the snapshot", |c| c.snapshots() == 1).await;

    let first_data = pods
        .seen
        .iter()
        .find(|e| !matches!(e, WatchEvent::Status { .. }))
        .unwrap();
    assert!(matches!(first_data, WatchEvent::Snapshot { items } if items.len() == 2));
    // A status before the first data can only say the watcher is still syncing.
    let before = pods
        .seen
        .iter()
        .take_while(|e| !matches!(e, WatchEvent::Snapshot { .. }));
    for event in before {
        assert!(
            matches!(
                event,
                WatchEvent::Status {
                    status: WatchStatus::Syncing,
                    ..
                }
            ),
            "{event:?}"
        );
    }

    fake.add_pod("default", "three");
    pods.until("the added pod", |c| c.has("default", "three"))
        .await;
    assert_eq!(pods.snapshots(), 1, "an upsert must arrive in a batch");
    assert!(pods.batches() >= 1);

    fake.delete_pod("default", "one");
    pods.until("the deleted pod", |c| !c.has("default", "one"))
        .await;
    assert_eq!(pods.snapshots(), 1, "a delete must arrive in a batch");
    let deleted = pods.seen.iter().any(|event| {
        matches!(event, WatchEvent::Batch { deletes, .. } if deletes.contains(&key("default", "one")))
    });
    assert!(deleted, "{}", pods.summary());

    pods.until("status live", |c| c.saw_status(WatchStatus::Live))
        .await;
}

#[tokio::test]
async fn second_subscriber_shares_the_watcher_and_gets_a_snapshot() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.add_pod("default", "one");
    let mut first = Consumer::subscribe(&core, &id, pods()).await;
    first.until("the snapshot", |c| c.snapshots() == 1).await;
    eventually("the watch", || fake.watch_request_count(PODS) == 1).await;
    fake.add_pod("default", "two");
    first
        .until("the second pod", |c| c.has("default", "two"))
        .await;
    let requests = fake.request_count(PODS);

    let mut second = Consumer::subscribe(&core, &id, pods()).await;
    second.until("the snapshot", |c| c.snapshots() == 1).await;

    assert!(second.has("default", "one") && second.has("default", "two"));
    assert_eq!(fake.watch_request_count(PODS), 1);
    assert_eq!(fake.request_count(PODS), requests, "no new list");
    assert_eq!(fake.open_watch_count(), 1);
}

#[tokio::test]
async fn watcher_closes_after_linger_when_no_subscribers_remain() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    core.set_watch_timing_for_test(FAST_BATCH, Duration::from_millis(200));
    fake.add_pod("default", "one");
    let mut first = Consumer::subscribe(&core, &id, pods()).await;
    first.until("the snapshot", |c| c.snapshots() == 1).await;
    eventually("the watch", || fake.open_watch_count() == 1).await;

    core.resources_unsubscribe(&first.id);
    fake.add_pod("default", "while-away");
    eventually("the watch to close", || fake.open_watch_count() == 0).await;

    let mut again = Consumer::subscribe(&core, &id, pods()).await;
    again.until("the snapshot", |c| c.snapshots() == 1).await;
    assert!(again.has("default", "one") && again.has("default", "while-away"));
}

#[tokio::test]
async fn dropping_the_receiver_counts_as_leaving() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    core.set_watch_timing_for_test(FAST_BATCH, Duration::from_millis(100));
    let mut first = Consumer::subscribe(&core, &id, pods()).await;
    first.until("the snapshot", |c| c.snapshots() == 1).await;
    eventually("the watch", || fake.open_watch_count() == 1).await;

    drop(first);

    eventually("the watch to close", || fake.open_watch_count() == 0).await;
}

#[tokio::test]
async fn resubscribe_within_linger_reuses_the_watcher() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.add_pod("default", "one");
    let mut first = Consumer::subscribe(&core, &id, pods()).await;
    first.until("the snapshot", |c| c.snapshots() == 1).await;
    eventually("the watch", || fake.open_watch_count() == 1).await;
    core.resources_unsubscribe(&first.id);
    fake.add_pod("default", "while-away");
    let requests = fake.request_count(PODS);

    let mut again = Consumer::subscribe(&core, &id, pods()).await;
    again.until("the snapshot", |c| c.snapshots() == 1).await;

    assert_eq!(fake.request_count(PODS), requests, "no new list or watch");
    assert_eq!(fake.open_watch_count(), 1);
    again
        .until("the pod added while away", |c| {
            c.has("default", "while-away")
        })
        .await;
}

fn object_with_server_fields(name: &str) -> Value {
    json!({
        "metadata": {
            "name": name,
            "namespace": "default",
            "annotations": {
                "kubectl.kubernetes.io/last-applied-configuration": "{\"marker\":\"applied\"}",
                "keep": "me",
            },
            "managedFields": [{ "manager": "marker-manager", "operation": "Apply" }],
        },
        "spec": { "containers": [] },
    })
}

#[tokio::test]
async fn managed_fields_are_stripped() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    // Not Pods: their rows drop every annotation, and this checks that others stay.
    fake.upsert("configmaps", object_with_server_fields("listed"));

    let configmaps = resource("", "ConfigMap", "configmaps", true);
    let mut table = Consumer::subscribe(&core, &id, configmaps).await;
    table.until("the snapshot", |c| c.snapshots() == 1).await;
    fake.upsert("configmaps", object_with_server_fields("watched"));
    table
        .until("the watched object", |c| c.has("default", "watched"))
        .await;

    let text = serde_json::to_string(&table.seen).unwrap();
    assert!(!text.contains("marker-manager"), "{text}");
    assert!(!text.contains("managedFields"), "{text}");
    assert!(!text.contains("last-applied-configuration"), "{text}");
    let row = table.rows.values().next().unwrap();
    assert_eq!(row["metadata"]["annotations"]["keep"], "me");
}

fn secret_object(name: &str) -> Value {
    json!({
        "metadata": {
            "name": name,
            "namespace": "default",
            "annotations": {
                "kubectl.kubernetes.io/last-applied-configuration":
                    "{\"data\":{\"password\":\"czNjcjN0\"}}",
            },
        },
        "type": "Opaque",
        "data": { "password": "czNjcjN0", "user": "czNjcjN0" },
        "stringData": { "token": "czNjcjN0" },
    })
}

#[tokio::test]
async fn secret_values_are_stripped_from_watch() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    // A list item carries no kind, so this one is recognized by the resource.
    fake.upsert("secrets", secret_object("listed"));

    let mut secrets = Consumer::subscribe(&core, &id, secrets()).await;
    secrets.until("the snapshot", |c| c.snapshots() == 1).await;
    fake.upsert("secrets", secret_object("watched"));
    secrets
        .until("the watched secret", |c| c.has("default", "watched"))
        .await;

    let text = serde_json::to_string(&secrets.seen).unwrap();
    assert!(!text.contains("czNjcjN0"), "{text}");
    for row in secrets.rows.values() {
        assert_eq!(row["data"]["password"], "");
        assert_eq!(row["data"]["user"], "");
        assert_eq!(row["stringData"]["token"], "");
        assert_eq!(row["kind"], "Secret");
    }
}

#[tokio::test]
async fn a_wrong_kind_does_not_exempt_secrets() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.upsert("secrets", secret_object("listed"));

    let wrong = resource("", "ConfigMap", "secrets", true);
    let mut secrets = Consumer::subscribe(&core, &id, wrong).await;
    secrets.until("the snapshot", |c| c.snapshots() == 1).await;

    let text = serde_json::to_string(&secrets.seen).unwrap();
    assert!(!text.contains("czNjcjN0"), "{text}");
}

#[tokio::test]
async fn a_resource_path_with_odd_characters_is_refused() {
    let (core, _fake, id, _root) = connected(FakeKubeConfig::default()).await;
    for wrong in [
        resource("", "Pod", "../v1/secrets", true),
        resource("", "Pod", "", true),
        resource("example.com/x", "Pod", "pods", true),
        ResourceRef {
            version: "v1/../v1".into(),
            ..pods()
        },
    ] {
        let (tx, _rx) = mpsc::channel(1);
        let err = core
            .resources_subscribe(&id, wrong.clone(), tx)
            .await
            .expect_err(&format!("{wrong:?}"));
        assert_eq!(err.code, skopos_core::error::ErrorCode::InvalidInput);
    }
}

fn numbered_pod(name: &str, rev: usize) -> Value {
    json!({
        "metadata": {
            "name": name,
            "namespace": "default",
            "labels": { "rev": rev.to_string() },
        },
        "spec": { "containers": [] },
    })
}

fn rev_of(consumer: &Consumer, name: &str) -> Option<String> {
    consumer
        .rows
        .get(&(Some("default".to_owned()), name.to_owned()))
        .and_then(|row| row.pointer("/metadata/labels/rev"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

#[tokio::test]
async fn updates_to_one_object_coalesce() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    core.set_watch_timing_for_test(Duration::from_millis(100), LONG_LINGER);
    fake.upsert("pods", numbered_pod("busy", 0));
    let mut pods = Consumer::subscribe(&core, &id, pods()).await;
    pods.until("the snapshot", |c| c.snapshots() == 1).await;
    eventually("the watch", || fake.open_watch_count() == 1).await;

    for rev in 1..=200 {
        fake.upsert("pods", numbered_pod("busy", rev));
    }

    pods.until("the last update", |c| {
        rev_of(c, "busy").as_deref() == Some("200")
    })
    .await;
    assert!(pods.batches() < 20, "{}", pods.summary());
    pods.drain_for(Duration::from_millis(250)).await;
    assert_eq!(rev_of(&pods, "busy").as_deref(), Some("200"));
}

#[tokio::test]
async fn slow_subscriber_does_not_block_others() {
    const OBJECTS: usize = 20;
    const ROUNDS: usize = 50;
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    let mut slow = Consumer::with_capacity(&core, &id, pods(), 1).await;
    let mut quick = Consumer::subscribe(&core, &id, pods()).await;
    quick.until("the snapshot", |c| c.snapshots() == 1).await;
    eventually("the watch", || fake.open_watch_count() == 1).await;

    for rev in 1..=ROUNDS {
        for n in 0..OBJECTS {
            fake.upsert("pods", numbered_pod(&format!("pod-{n}"), rev));
        }
    }
    let last_rev = ROUNDS.to_string();
    let last_pod = format!("pod-{}", OBJECTS - 1);
    let started = Instant::now();
    quick
        .until("the last update", |c| {
            rev_of(c, &last_pod).as_deref() == Some(last_rev.as_str())
        })
        .await;
    assert!(
        started.elapsed() < QUIET,
        "the quick subscriber took {:?}",
        started.elapsed()
    );

    slow.until("the final state", |c| {
        (0..OBJECTS).all(|n| rev_of(c, &format!("pod-{n}")).as_deref() == Some(last_rev.as_str()))
    })
    .await;
    assert_eq!(slow.rows.len(), OBJECTS);
    // Pending holds one entry per object, so no batch can exceed the object count
    // and repeat one, and a thousand updates arrive as very few events.
    for event in &slow.seen {
        if let WatchEvent::Batch { upserts, .. } = event {
            assert!(upserts.len() <= OBJECTS, "{}", upserts.len());
            let unique: HashSet<_> = upserts.iter().map(|o| row_of(&o.to_value()).name).collect();
            assert_eq!(unique.len(), upserts.len());
        }
    }
    assert!(slow.seen.len() < 20, "{}", slow.summary());
}

#[tokio::test]
async fn a_stalled_subscriber_keeps_no_entry_for_objects_long_gone() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    let mut stalled = Consumer::with_capacity(&core, &id, pods(), 1).await;
    let mut quick = Consumer::subscribe(&core, &id, pods()).await;
    quick.until("the snapshot", |c| c.snapshots() == 1).await;
    eventually("the watch", || fake.open_watch_count() == 1).await;
    // Let the stalled subscriber's first events reach its channel.
    tokio::time::sleep(Duration::from_millis(100)).await;

    for n in 0..600 {
        let name = format!("short-lived-{n}");
        fake.add_pod("default", &name);
        fake.delete_pod("default", &name);
    }
    fake.add_pod("default", "last");
    quick
        .until("the last pod", |c| c.has("default", "last"))
        .await;

    stalled
        .until("the last pod", |c| c.has("default", "last"))
        .await;
    // The names that came and went were folded into a fresh snapshot.
    for event in &stalled.seen {
        if let WatchEvent::Batch { upserts, deletes } = event {
            assert!(upserts.len() + deletes.len() < 600, "{}", stalled.summary());
        }
    }
    assert_eq!(stalled.rows.len(), 1);
}

#[tokio::test]
async fn watch_drop_reconnects_and_reports_status() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.add_pod("default", "one");
    let mut pods = Consumer::subscribe(&core, &id, pods()).await;
    pods.until("status live", |c| c.saw_status(WatchStatus::Live))
        .await;
    eventually("the watch", || fake.open_watch_count() == 1).await;

    fake.fail_watches_with("pods", Some(500));
    fake.drop_watches();
    pods.until("status reconnecting", |c| {
        c.saw_status(WatchStatus::Reconnecting)
    })
    .await;
    let message = pods.status_message(WatchStatus::Reconnecting).unwrap();
    assert!(message.contains("injected failure"), "{message}");
    assert!(pods.has("default", "one"), "the last data stays");
    let marker = pods.seen.len();
    fake.add_pod("default", "during-outage");

    fake.fail_watches_with("pods", None);
    pods.until("the resync", |c| c.snapshots() == 2).await;

    assert!(pods.has("default", "during-outage"));
    let after: Vec<&WatchEvent> = pods.seen[marker..].iter().collect();
    let live = after
        .iter()
        .position(|e| {
            matches!(
                e,
                WatchEvent::Status {
                    status: WatchStatus::Live,
                    ..
                }
            )
        })
        .expect("status live after the outage");
    let snapshot = after
        .iter()
        .position(|e| matches!(e, WatchEvent::Snapshot { .. }))
        .unwrap();
    assert!(live < snapshot, "{}", pods.summary());
}

#[tokio::test]
async fn a_failing_watcher_backs_off() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    let mut pods = Consumer::subscribe(&core, &id, pods()).await;
    pods.until("status live", |c| c.saw_status(WatchStatus::Live))
        .await;
    eventually("the watch", || fake.open_watch_count() == 1).await;
    let before = fake.request_count(PODS);

    fake.fail_watches_with("pods", Some(500));
    fake.drop_watches();
    tokio::time::sleep(Duration::from_millis(3500)).await;

    // At most: the failed rewatch, then attempts after 1 s and 2 s more.
    let attempts = fake.request_count(PODS) - before;
    assert!((2..=4).contains(&attempts), "{attempts} attempts");
}

#[tokio::test]
async fn an_expired_resource_version_lists_again_without_reconnecting() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.add_pod("default", "one");
    let mut pods = Consumer::subscribe(&core, &id, pods()).await;
    pods.until("status live", |c| c.saw_status(WatchStatus::Live))
        .await;
    eventually("the watch", || fake.open_watch_count() == 1).await;

    fake.expire_watches("pods");

    pods.until("the fresh snapshot", |c| c.snapshots() == 2)
        .await;
    assert!(!pods.saw_status(WatchStatus::Reconnecting));
    assert!(pods.has("default", "one"));
}

#[tokio::test]
async fn cluster_wide_forbidden_falls_back_to_namespaces() {
    let (core, fake, id, _root) = connected(FakeKubeConfig {
        forbid_cluster_wide_pods: true,
        namespaces: vec!["a".into(), "b".into()],
        ..Default::default()
    })
    .await;
    fake.add_pod("a", "in-a");
    fake.add_pod("b", "in-b");

    let mut pods = Consumer::subscribe(&core, &id, pods()).await;
    pods.until("the snapshot", |c| c.snapshots() == 1).await;
    assert!(pods.has("a", "in-a") && pods.has("b", "in-b"));
    pods.until("status live", |c| c.saw_status(WatchStatus::Live))
        .await;
    eventually("both watches", || fake.open_watch_count() == 2).await;

    assert_eq!(fake.watch_request_count(PODS), 0);
    assert_eq!(fake.watch_request_count("/api/v1/namespaces/a/pods"), 1);
    assert_eq!(fake.watch_request_count("/api/v1/namespaces/b/pods"), 1);
    assert!(!pods.saw_status(WatchStatus::Reconnecting));

    fake.add_pod("b", "later");
    pods.until("the merged update", |c| c.has("b", "later"))
        .await;
    fake.delete_pod("a", "in-a");
    pods.until("the merged delete", |c| !c.has("a", "in-a"))
        .await;
    assert!(pods.has("b", "in-b"));
}

#[tokio::test]
async fn one_forbidden_namespace_leaves_the_others_live() {
    let (core, fake, id, _root) = connected(FakeKubeConfig {
        forbid_cluster_wide_pods: true,
        namespaces: vec!["a".into(), "b".into()],
        deny: vec![DenyRule {
            verb: "list".into(),
            plural: "pods".into(),
            namespace: Some("b".into()),
        }],
        ..Default::default()
    })
    .await;
    fake.add_pod("a", "in-a");
    fake.add_pod("b", "in-b");

    let mut pods = Consumer::subscribe(&core, &id, pods()).await;
    pods.until("status live", |c| c.saw_status(WatchStatus::Live))
        .await;
    pods.until("the snapshot", |c| c.snapshots() == 1).await;

    assert!(pods.has("a", "in-a"));
    assert!(!pods.has("b", "in-b"));
    assert!(!pods.saw_status(WatchStatus::Forbidden));
}

#[tokio::test]
async fn all_namespaces_forbidden_reports_forbidden_and_stops() {
    let (core, fake, id, _root) = connected(FakeKubeConfig {
        namespaces: vec!["a".into(), "b".into()],
        deny: vec![deny_list("pods")],
        ..Default::default()
    })
    .await;

    let mut pods = Consumer::subscribe(&core, &id, pods()).await;
    pods.until("status forbidden", |c| c.saw_status(WatchStatus::Forbidden))
        .await;
    let message = pods.status_message(WatchStatus::Forbidden).unwrap();
    assert!(message.contains("cannot list resource"), "{message}");
    pods.until_closed("the subscription", QUIET).await;

    let count = || {
        fake.request_count(PODS)
            + fake.request_count("/api/v1/namespaces/a/pods")
            + fake.request_count("/api/v1/namespaces/b/pods")
    };
    let settled = count();
    assert!(settled <= 3, "{settled} requests");
    tokio::time::sleep(QUIET).await;
    assert_eq!(count(), settled, "no retries");
}

#[tokio::test]
async fn forbidden_cluster_scoped_resource_does_not_fall_back() {
    let (core, fake, id, _root) = connected(FakeKubeConfig {
        deny: vec![deny_list("nodes")],
        ..Default::default()
    })
    .await;

    let nodes = resource("", "Node", "nodes", false);
    let mut nodes = Consumer::subscribe(&core, &id, nodes).await;
    nodes
        .until("status forbidden", |c| c.saw_status(WatchStatus::Forbidden))
        .await;

    assert_eq!(fake.request_count("/api/v1/namespaces/default/nodes"), 0);
}

#[tokio::test]
async fn resource_gone_reports_not_served_and_stops() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.serve_resource(fake_widgets());
    fake.upsert("widgets", widget("one"));

    let mut widgets_sub = Consumer::subscribe(&core, &id, widgets()).await;
    widgets_sub
        .until("status live", |c| c.saw_status(WatchStatus::Live))
        .await;
    eventually("the watch", || fake.open_watch_count() == 1).await;

    fake.remove_resource("widgets");

    widgets_sub
        .until("status not served", |c| {
            c.saw_status(WatchStatus::NotServed)
        })
        .await;
    assert!(widgets_sub.has("default", "one"), "the last data stays");
    let requests = fake.request_count(WIDGETS);
    let documents = fake.request_count("/apis/example.com/v1");
    tokio::time::sleep(QUIET).await;
    assert_eq!(fake.request_count(WIDGETS), requests, "no retries");
    assert_eq!(
        fake.request_count("/apis/example.com/v1"),
        documents,
        "no discovery retries"
    );

    // Coming back to the table after the CRD returns starts over.
    fake.serve_resource(fake_widgets());
    fake.upsert("widgets", widget("reborn"));
    let mut again = Consumer::subscribe(&core, &id, widgets()).await;
    again.until("the snapshot", |c| c.snapshots() == 1).await;
    assert!(again.has("default", "reborn"));
}

#[tokio::test]
async fn resource_gone_from_a_group_that_stays_reports_not_served() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.serve_resource(fake_widgets());
    fake.serve_resource(FakeResource::new(
        "example.com",
        "v1",
        "Gadget",
        "gadgets",
        true,
    ));
    let mut widgets_sub = Consumer::subscribe(&core, &id, widgets()).await;
    widgets_sub
        .until("status live", |c| c.saw_status(WatchStatus::Live))
        .await;
    eventually("the watch", || fake.open_watch_count() == 1).await;

    fake.remove_resource("widgets");

    widgets_sub
        .until("status not served", |c| {
            c.saw_status(WatchStatus::NotServed)
        })
        .await;
}

#[tokio::test]
async fn not_found_while_discovery_still_serves_it_keeps_retrying() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.serve_resource(fake_widgets());
    let mut widgets_sub = Consumer::subscribe(&core, &id, widgets()).await;
    widgets_sub
        .until("status live", |c| c.saw_status(WatchStatus::Live))
        .await;
    eventually("the watch", || fake.open_watch_count() == 1).await;

    fake.fail_watches_with("widgets", Some(404));
    fake.drop_watches();
    widgets_sub
        .until("status reconnecting", |c| {
            c.saw_status(WatchStatus::Reconnecting)
        })
        .await;
    fake.fail_watches_with("widgets", None);

    widgets_sub
        .until("the resync", |c| c.snapshots() == 2)
        .await;
    assert!(!widgets_sub.saw_status(WatchStatus::NotServed));
}

#[tokio::test]
async fn disconnect_ends_subscriptions_without_panic() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.add_pod("default", "one");
    let mut pods_sub = Consumer::subscribe(&core, &id, pods()).await;
    pods_sub.until("the snapshot", |c| c.snapshots() == 1).await;
    // A subscriber that never reads must close too.
    let mut stalled = Consumer::with_capacity(&core, &id, pods(), 1).await;
    eventually("the watch", || fake.open_watch_count() == 1).await;
    fake.add_pod("default", "two");
    tokio::time::sleep(Duration::from_millis(100)).await;

    core.cluster_disconnect(&id).await.unwrap();

    pods_sub.until_closed("the subscription", QUIET).await;
    stalled
        .until_closed("the stalled subscription", QUIET)
        .await;
    eventually("the watch to close", || fake.open_watch_count() == 0).await;

    let state = core.cluster_connect(&id).await.unwrap();
    assert!(matches!(state, ConnectionState::Connected { .. }));
    let mut again = Consumer::subscribe(&core, &id, pods()).await;
    again.until("the snapshot", |c| c.snapshots() == 1).await;
    assert!(again.has("default", "one") && again.has("default", "two"));
}

#[tokio::test]
async fn subscribing_to_disconnected_cluster_errors() {
    let (core, _fake, id, _root) = connected(FakeKubeConfig::default()).await;
    core.cluster_disconnect(&id).await.unwrap();

    let (tx, _rx) = mpsc::channel(1);
    assert!(core.resources_subscribe(&id, pods(), tx).await.is_err());

    let (tx, _rx) = mpsc::channel(1);
    assert!(core
        .resources_subscribe(&"no-such-cluster".to_owned(), pods(), tx)
        .await
        .is_err());
}

/// A table holds every Pod row, so a row carries only what the UI reads outside the drawer.
#[tokio::test]
async fn a_watched_pod_row_is_trimmed_and_a_get_returns_the_whole_pod() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.upsert(
        "pods",
        json!({
            "metadata": {
                "name": "full",
                "namespace": "default",
                "labels": { "app": "web" },
                "annotations": { "note": "for the drawer" },
            },
            "spec": { "containers": [{
                "name": "main",
                "image": "registry.k8s.io/pause:3.10",
                "env": [{ "name": "A", "value": "1" }],
            }] },
            "status": { "phase": "Running" },
        }),
    );
    let mut table = Consumer::subscribe(&core, &id, pods()).await;
    table.until("the pod", |c| c.has("default", "full")).await;
    let row = &table.rows[&(Some("default".to_owned()), "full".to_owned())];
    assert_eq!(row["metadata"]["labels"], json!({ "app": "web" }));
    assert_eq!(
        row["spec"]["containers"],
        json!([{ "name": "main", "image": "registry.k8s.io/pause:3.10" }])
    );
    assert_eq!(row["status"]["phase"], "Running");
    assert!(row["metadata"].get("annotations").is_none(), "{row}");

    let whole = core
        .resource_get(&id, &pods(), Some("default"), "full")
        .await
        .unwrap();
    assert_eq!(
        whole["metadata"]["annotations"],
        json!({ "note": "for the drawer" })
    );
    assert_eq!(
        whole["spec"]["containers"][0]["env"],
        json!([{ "name": "A", "value": "1" }])
    );
}
