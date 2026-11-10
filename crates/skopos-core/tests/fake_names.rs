//! `resources_names` against the fake API server (spec C §10.1, §13.2).
//! Every kubeconfig lives in a temp `<home>/.kube`; `KUBECONFIG` is never read.

use std::time::{Duration, Instant};

use serde_json::{json, Value};
use skopos_core::app_core::AppCore;
use skopos_core::cluster::ConnectionState;
use skopos_core::error::ErrorCode;
use skopos_core::kubeconfig::ClusterId;
use skopos_core::paths::AppPaths;
use skopos_core::resources::{ObjectName, ObjectNames};
use skopos_fakekube::{DenyRule, FakeKube, FakeKubeConfig, FakeResource};
use tempfile::TempDir;

const CONTEXT: &str = "fake";
const PODS: &str = "/api/v1/pods";

/// The palette's kinds in their order (spec C §10.1).
const ALL_KINDS: [&str; 14] = [
    "pods",
    "deployments",
    "statefulsets",
    "daemonsets",
    "replicasets",
    "jobs",
    "cronjobs",
    "services",
    "ingresses",
    "configmaps",
    "secrets",
    "persistentvolumeclaims",
    "nodes",
    "namespaces",
];

/// Serves the seven kinds the default fake leaves out, before discovery reads them.
fn serve_extra(fake: &FakeKube) {
    for r in [
        FakeResource::new("apps", "v1", "StatefulSet", "statefulsets", true),
        FakeResource::new("apps", "v1", "DaemonSet", "daemonsets", true),
        FakeResource::new("apps", "v1", "ReplicaSet", "replicasets", true),
        FakeResource::new("batch", "v1", "Job", "jobs", true),
        FakeResource::new("batch", "v1", "CronJob", "cronjobs", true),
        FakeResource::new("networking.k8s.io", "v1", "Ingress", "ingresses", true),
        FakeResource::new(
            "",
            "v1",
            "PersistentVolumeClaim",
            "persistentvolumeclaims",
            true,
        ),
    ] {
        fake.serve_resource(r);
    }
}

/// Starts the fake, lets `prepare` serve kinds before the connection's discovery
/// reads them, and connects.
async fn connected(
    cfg: FakeKubeConfig,
    prepare: impl FnOnce(&FakeKube),
) -> (AppCore, FakeKube, ClusterId, TempDir) {
    let fake = FakeKube::start(cfg).await.unwrap();
    prepare(&fake);
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

fn object(namespace: Option<&str>, name: &str) -> Value {
    match namespace {
        Some(namespace) => json!({ "metadata": { "name": name, "namespace": namespace } }),
        None => json!({ "metadata": { "name": name } }),
    }
}

fn deny(verb: &str, plural: &str) -> DenyRule {
    DenyRule {
        verb: verb.into(),
        plural: plural.into(),
        namespace: None,
    }
}

fn names_of<'a>(names: &'a ObjectNames, plural: &str) -> Vec<&'a str> {
    names
        .items
        .iter()
        .filter(|o| o.plural == plural)
        .map(|o| o.name.as_str())
        .collect()
}

/// The plurals in the order the answer lists them, each once.
fn plurals(names: &ObjectNames) -> Vec<&str> {
    let mut out: Vec<&str> = Vec::new();
    for o in &names.items {
        if out.last() != Some(&o.plural.as_str()) {
            out.push(o.plural.as_str());
        }
    }
    out
}

fn name(kind: &str, group: &str, plural: &str, namespace: Option<&str>, name: &str) -> ObjectName {
    ObjectName {
        kind: kind.into(),
        group: group.into(),
        plural: plural.into(),
        namespace: namespace.map(Into::into),
        name: name.into(),
    }
}

#[tokio::test]
async fn reads_the_fourteen_kinds_in_order_as_metadata_only() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default(), serve_extra).await;
    for plural in &ALL_KINDS[..12] {
        fake.upsert(plural, object(Some("default"), &format!("{plural}-1")));
    }
    fake.upsert(
        "secrets",
        json!({ "metadata": { "name": "token", "namespace": "default" }, "data": { "password": "c2VjcmV0" } }),
    );
    fake.upsert("nodes", object(None, "node-a"));

    let names = core.resources_names(&id).await.unwrap();

    assert_eq!(plurals(&names), ALL_KINDS);
    assert!(names
        .items
        .contains(&name("Secret", "", "secrets", Some("default"), "token")));
    assert!(names.items.contains(&name(
        "Ingress",
        "networking.k8s.io",
        "ingresses",
        Some("default"),
        "ingresses-1"
    )));
    assert!(names
        .items
        .contains(&name("Node", "", "nodes", None, "node-a")));
    assert_eq!(names_of(&names, "namespaces"), ["default", "kube-system"]);
    assert!(names.truncated.is_empty());
    // A metadata-only list: no Secret value or spec crossed the wire.
    assert_eq!(fake.metadata_list_count("/api/v1/secrets"), 1);
    assert_eq!(fake.metadata_list_count("/apis/apps/v1/deployments"), 1);
}

#[tokio::test]
async fn skips_a_kind_discovery_does_not_have() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default(), |_| {}).await;
    fake.upsert("pods", object(Some("default"), "web"));

    let names = core.resources_names(&id).await.unwrap();

    assert_eq!(
        plurals(&names),
        ["pods", "namespaces"],
        "only kinds with objects show; the unserved ones are skipped"
    );
    assert_eq!(fake.request_count("/apis/apps/v1/statefulsets"), 0);
}

#[tokio::test]
async fn skips_kinds_that_answer_403_or_404() {
    let cfg = FakeKubeConfig {
        deny: vec![deny("list", "secrets")],
        ..Default::default()
    };
    let (core, fake, id, _root) = connected(cfg, |_| {}).await;
    fake.upsert("secrets", object(Some("default"), "token"));
    fake.upsert("configmaps", object(Some("default"), "settings"));
    fake.upsert("pods", object(Some("default"), "web"));
    fake.fail_watches_with("configmaps", Some(404));

    let names = core.resources_names(&id).await.unwrap();

    assert!(names_of(&names, "secrets").is_empty());
    assert!(names_of(&names, "configmaps").is_empty());
    assert_eq!(names_of(&names, "pods"), ["web"]);
}

#[tokio::test]
async fn reads_each_namespace_after_a_cluster_wide_403() {
    let cfg = FakeKubeConfig {
        deny_cluster_wide: vec![deny("list", "configmaps")],
        ..Default::default()
    };
    let (core, fake, id, _root) = connected(cfg, |_| {}).await;
    fake.upsert("configmaps", object(Some("default"), "a"));
    fake.upsert("configmaps", object(Some("kube-system"), "b"));

    let names = core.resources_names(&id).await.unwrap();

    let found: Vec<(Option<&str>, &str)> = names
        .items
        .iter()
        .filter(|o| o.plural == "configmaps")
        .map(|o| (o.namespace.as_deref(), o.name.as_str()))
        .collect();
    assert_eq!(found, [(Some("default"), "a"), (Some("kube-system"), "b")]);
    assert_eq!(
        fake.request_count("/api/v1/namespaces/default/configmaps"),
        1
    );
    assert_eq!(
        fake.request_count("/api/v1/namespaces/kube-system/configmaps"),
        1
    );
}

#[tokio::test]
async fn stops_at_two_thousand_names_and_marks_the_kind_truncated() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default(), |_| {}).await;
    for i in 0..2001 {
        fake.upsert("configmaps", object(Some("default"), &format!("cm-{i:04}")));
    }

    let names = core.resources_names(&id).await.unwrap();

    assert_eq!(names_of(&names, "configmaps").len(), 2000);
    assert_eq!(names.truncated, ["configmaps"]);
}

#[tokio::test]
async fn the_namespace_fallback_stops_at_two_thousand_in_total() {
    let cfg = FakeKubeConfig {
        deny_cluster_wide: vec![deny("list", "configmaps")],
        ..Default::default()
    };
    let (core, fake, id, _root) = connected(cfg, |_| {}).await;
    for namespace in ["default", "kube-system"] {
        for i in 0..1500 {
            fake.upsert("configmaps", object(Some(namespace), &format!("cm-{i:04}")));
        }
    }

    let names = core.resources_names(&id).await.unwrap();

    assert_eq!(names_of(&names, "configmaps").len(), 2000);
    assert_eq!(names.truncated, ["configmaps"]);
}

#[tokio::test]
async fn fails_only_when_no_kind_could_be_read() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default(), |_| {}).await;
    fake.fail_watches_with("pods", Some(500));
    for plural in [
        "deployments",
        "services",
        "configmaps",
        "secrets",
        "nodes",
        "namespaces",
    ] {
        fake.fail_watches_with(plural, Some(403));
    }

    let error = core.resources_names(&id).await.unwrap_err();

    assert_eq!(error.code, ErrorCode::Internal);
}

#[tokio::test]
async fn a_failure_beside_a_kind_that_was_read_is_not_an_error() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default(), |_| {}).await;
    fake.upsert("nodes", object(None, "node-a"));
    fake.fail_watches_with("pods", Some(500));

    let names = core.resources_names(&id).await.unwrap();

    assert_eq!(names_of(&names, "nodes"), ["node-a"]);
    assert!(names_of(&names, "pods").is_empty());
}

#[tokio::test]
async fn a_user_who_may_list_none_of_the_kinds_gets_an_empty_answer() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default(), serve_extra).await;
    for plural in ALL_KINDS {
        fake.fail_watches_with(plural, Some(403));
    }

    let names = core.resources_names(&id).await.unwrap();

    assert_eq!(
        names,
        ObjectNames {
            items: Vec::new(),
            truncated: Vec::new()
        }
    );
}

#[tokio::test]
async fn answers_from_the_cache_and_drops_it_on_disconnect() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default(), |_| {}).await;
    fake.upsert("pods", object(Some("default"), "first"));
    let before = fake.request_count(PODS);

    let first = core.resources_names(&id).await.unwrap();
    assert_eq!(fake.request_count(PODS), before + 1);

    fake.upsert("pods", object(Some("default"), "second"));
    let again = core.resources_names(&id).await.unwrap();
    assert_eq!(again, first, "the second call is answered from the cache");
    assert_eq!(fake.request_count(PODS), before + 1);

    core.cluster_disconnect(&id).await.unwrap();
    let state = core.cluster_connect(&id).await.unwrap();
    assert!(
        matches!(state, ConnectionState::Connected { .. }),
        "{state:?}"
    );
    let fresh = core.resources_names(&id).await.unwrap();
    assert_eq!(names_of(&fresh, "pods"), ["first", "second"]);
}

#[tokio::test]
async fn the_cache_expires_after_its_ttl() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default(), |_| {}).await;
    core.set_names_ttl_for_test(Duration::ZERO);
    let before = fake.request_count(PODS);

    core.resources_names(&id).await.unwrap();
    core.resources_names(&id).await.unwrap();

    assert_eq!(fake.request_count(PODS), before + 2);
}

#[tokio::test]
async fn a_cluster_that_is_not_connected_is_refused() {
    let (core, _fake, id, _root) = connected(FakeKubeConfig::default(), |_| {}).await;
    core.cluster_disconnect(&id).await.unwrap();

    let error = core.resources_names(&id).await.unwrap_err();

    assert_eq!(error.code, ErrorCode::InvalidInput);
}
