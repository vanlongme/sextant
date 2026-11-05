//! Object operations and multi-document apply against the fake API server.
//! Every kubeconfig lives in a temp `<home>/.kube`; `KUBECONFIG` is never read.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use sextant_core::app_core::AppCore;
use sextant_core::cluster::ConnectionState;
use sextant_core::error::ErrorCode;
use sextant_core::kubeconfig::ClusterId;
use sextant_core::paths::AppPaths;
use sextant_core::resources::{InvolvedRef, Propagation, ResourceRef};
use sextant_fakekube::{DenyRule, FakeKube, FakeKubeConfig, FakeResource};
use tempfile::TempDir;

const CONTEXT: &str = "fake";
const CONFIGMAP_PATH: &str = "/api/v1/namespaces/default/configmaps/app";

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

fn core_resource(kind: &str, plural: &str) -> ResourceRef {
    ResourceRef {
        group: String::new(),
        version: "v1".into(),
        plural: plural.into(),
        kind: kind.into(),
        namespaced: true,
    }
}

fn configmaps() -> ResourceRef {
    core_resource("ConfigMap", "configmaps")
}

fn secrets() -> ResourceRef {
    core_resource("Secret", "secrets")
}

fn upsert_configmap(fake: &FakeKube, value: &str) {
    fake.upsert(
        "configmaps",
        json!({
            "metadata": { "name": "app", "namespace": "default" },
            "data": { "key": value },
        }),
    );
}

fn upsert_secret(fake: &FakeKube) {
    fake.upsert(
        "secrets",
        json!({
            "metadata": {
                "name": "creds",
                "namespace": "default",
                "managedFields": [{ "manager": "m" }],
            },
            "type": "Opaque",
            "data": { "password": "czNjcjN0" },
        }),
    );
}

async fn configmap_yaml(core: &AppCore, id: &ClusterId) -> String {
    core.resource_get_yaml(id, &configmaps(), Some("default"), "app")
        .await
        .unwrap()
}

#[tokio::test]
async fn resource_get_masks_secret_values() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    upsert_secret(&fake);

    let secret = core
        .resource_get(&id, &secrets(), Some("default"), "creds")
        .await
        .unwrap();

    assert!(!secret.to_string().contains("czNjcjN0"), "{secret}");
    assert_eq!(secret["data"], json!({ "password": "" }));
    assert!(secret["metadata"].get("managedFields").is_none());
}

#[tokio::test]
async fn resource_get_masks_a_secret_whatever_kind_the_caller_names() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    upsert_secret(&fake);

    let secret = core
        .resource_get(
            &id,
            &core_resource("NotASecret", "secrets"),
            Some("default"),
            "creds",
        )
        .await
        .unwrap();

    assert!(!secret.to_string().contains("czNjcjN0"), "{secret}");
}

#[tokio::test]
async fn get_yaml_removes_managed_fields_and_keeps_secret_data() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    upsert_secret(&fake);

    let yaml = core
        .resource_get_yaml(&id, &secrets(), Some("default"), "creds")
        .await
        .unwrap();

    assert!(!yaml.contains("managedFields"), "{yaml}");
    assert!(yaml.contains("czNjcjN0"), "{yaml}");
    let parsed: Value = serde_yaml_ng::from_str(&yaml).unwrap();
    assert_eq!(parsed["kind"], "Secret");
    assert_eq!(parsed["metadata"]["name"], "creds");
}

#[tokio::test]
async fn replace_uses_resource_version_and_reports_conflict() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    upsert_configmap(&fake, "first");
    let stale = configmap_yaml(&core, &id).await;
    upsert_configmap(&fake, "second");

    let err = core
        .resource_replace(&id, &configmaps(), Some("default"), "app", &stale, false)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict);
    assert!(err.message.contains("modified"), "{}", err.message);

    let fresh = configmap_yaml(&core, &id).await.replace("second", "third");
    let stored = core
        .resource_replace(&id, &configmaps(), Some("default"), "app", &fresh, false)
        .await
        .unwrap();
    assert_eq!(stored["data"]["key"], "third");
    let writes = fake.writes("PUT", CONFIGMAP_PATH);
    assert_eq!(writes.len(), 2);
    assert_eq!(
        writes[1].body["metadata"]["resourceVersion"].as_str(),
        serde_yaml_ng::from_str::<Value>(&fresh).unwrap()["metadata"]["resourceVersion"].as_str()
    );
}

#[tokio::test]
async fn replace_with_force_overwrites_after_conflict() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    upsert_configmap(&fake, "first");
    let stale = configmap_yaml(&core, &id).await;
    upsert_configmap(&fake, "second");
    let current = core
        .resource_get(&id, &configmaps(), Some("default"), "app")
        .await
        .unwrap();

    let stored = core
        .resource_replace(&id, &configmaps(), Some("default"), "app", &stale, true)
        .await
        .unwrap();

    assert_eq!(stored["data"]["key"], "first");
    let writes = fake.writes("PUT", CONFIGMAP_PATH);
    assert_eq!(writes.len(), 1);
    assert_eq!(
        writes[0].body["metadata"]["resourceVersion"],
        current["metadata"]["resourceVersion"]
    );
}

#[tokio::test]
async fn replace_returns_a_secret_with_its_values_masked() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    upsert_secret(&fake);
    let yaml = core
        .resource_get_yaml(&id, &secrets(), Some("default"), "creds")
        .await
        .unwrap();

    let stored = core
        .resource_replace(&id, &secrets(), Some("default"), "creds", &yaml, false)
        .await
        .unwrap();

    assert!(!stored.to_string().contains("czNjcjN0"), "{stored}");
    assert_eq!(stored["data"], json!({ "password": "" }));
}

#[tokio::test]
async fn replace_rejects_invalid_yaml_before_any_request() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    upsert_configmap(&fake, "first");
    let before = fake.request_count(CONFIGMAP_PATH);

    let err = core
        .resource_replace(
            &id,
            &configmaps(),
            Some("default"),
            "app",
            "kind: ConfigMap\ndata: [tok-SECRET-value\n",
            false,
        )
        .await
        .unwrap_err();

    assert_eq!(err.code, ErrorCode::InvalidInput);
    assert!(err.message.contains("line "), "{}", err.message);
    assert!(err.message.contains("column "), "{}", err.message);
    assert!(!err.message.contains("tok-SECRET"), "{}", err.message);
    assert_eq!(fake.request_count(CONFIGMAP_PATH), before);
}

#[tokio::test]
async fn replace_rejects_a_changed_name_or_kind() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    upsert_configmap(&fake, "first");
    let yaml = configmap_yaml(&core, &id).await;
    let cases = [
        ("name", yaml.replace("name: app", "name: other")),
        ("kind", yaml.replace("kind: ConfigMap", "kind: Secret")),
        (
            "apiVersion",
            yaml.replace("apiVersion: v1", "apiVersion: v2"),
        ),
        (
            "namespace",
            yaml.replace("namespace: default", "namespace: kube-system"),
        ),
    ];

    for (field, changed) in cases {
        assert_ne!(changed, yaml, "{field}");
        let err = core
            .resource_replace(&id, &configmaps(), Some("default"), "app", &changed, false)
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidInput, "{field}");
        assert!(err.message.contains(field), "{}", err.message);
    }
    assert!(fake.writes("PUT", CONFIGMAP_PATH).is_empty());
}

#[tokio::test]
async fn replace_needs_a_resource_version_unless_forced() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    upsert_configmap(&fake, "first");
    let yaml = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: app\ndata:\n  key: second\n";

    let err = core
        .resource_replace(&id, &configmaps(), Some("default"), "app", yaml, false)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidInput);
    assert!(err.message.contains("resourceVersion"), "{}", err.message);
    assert!(fake.writes("PUT", CONFIGMAP_PATH).is_empty());

    let stored = core
        .resource_replace(&id, &configmaps(), Some("default"), "app", yaml, true)
        .await
        .unwrap();
    assert_eq!(stored["data"]["key"], "second");
}

#[tokio::test]
async fn replace_rejects_more_than_one_document() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    upsert_configmap(&fake, "first");
    let yaml = configmap_yaml(&core, &id).await;

    let err = core
        .resource_replace(
            &id,
            &configmaps(),
            Some("default"),
            "app",
            &format!("{yaml}---\n{yaml}"),
            false,
        )
        .await
        .unwrap_err();

    assert_eq!(err.code, ErrorCode::InvalidInput);
    assert!(fake.writes("PUT", CONFIGMAP_PATH).is_empty());
}

#[tokio::test]
async fn apply_reports_each_document() {
    let (core, _fake, id, _root) = connected(FakeKubeConfig::default()).await;
    let yaml =
        "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: one\n  namespace: kube-system\n\
                ---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: two\n";

    let results = core.resource_apply(&id, yaml, "default").await.unwrap();

    assert_eq!(results.len(), 2);
    for (index, (result, (namespace, name))) in results
        .iter()
        .zip([("kube-system", "one"), ("default", "two")])
        .enumerate()
    {
        assert!(result.ok, "{result:?}");
        assert_eq!(result.index as usize, index);
        assert_eq!(result.kind.as_deref(), Some("ConfigMap"));
        assert_eq!(result.namespace.as_deref(), Some(namespace));
        assert_eq!(result.name.as_deref(), Some(name));
        core.resource_get(&id, &configmaps(), Some(namespace), name)
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn apply_ignores_the_default_namespace_for_cluster_scoped_objects() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    let yaml = "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: fresh\n";

    let results = core.resource_apply(&id, yaml, "default").await.unwrap();

    assert!(results[0].ok, "{:?}", results[0]);
    assert_eq!(results[0].namespace, None);
    let writes = fake.writes("PATCH", "/api/v1/namespaces/fresh");
    assert_eq!(writes.len(), 1);
    assert!(writes[0].body["metadata"].get("namespace").is_none());
}

#[tokio::test]
async fn apply_skips_empty_and_comment_only_documents() {
    let (core, _fake, id, _root) = connected(FakeKubeConfig::default()).await;
    let yaml = "---\n# just a comment\n---\n---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: real\n";

    let results = core.resource_apply(&id, yaml, "default").await.unwrap();

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].index, 0);
    assert!(results[0].ok, "{:?}", results[0]);
    assert_eq!(results[0].name.as_deref(), Some("real"));
}

#[tokio::test]
async fn apply_continues_after_a_failed_document() {
    let (core, _fake, id, _root) = connected(FakeKubeConfig::default()).await;
    let yaml = "apiVersion: example.com/v1\nkind: Gadget\nmetadata:\n  name: g\n\
                ---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: after\n";

    let results = core.resource_apply(&id, yaml, "default").await.unwrap();

    assert_eq!(results.len(), 2);
    assert!(!results[0].ok);
    assert_eq!(
        results[0].message,
        r#"unknown kind "Gadget" in apiVersion "example.com/v1""#
    );
    assert_eq!(results[0].kind.as_deref(), Some("Gadget"));
    assert!(results[1].ok, "{:?}", results[1]);
    core.resource_get(&id, &configmaps(), Some("default"), "after")
        .await
        .unwrap();
}

#[tokio::test]
async fn apply_reports_a_document_without_a_kind_or_name_and_continues() {
    let (core, _fake, id, _root) = connected(FakeKubeConfig::default()).await;
    let yaml = "apiVersion: v1\nmetadata:\n  name: a\n\
                ---\napiVersion: v1\nkind: ConfigMap\nmetadata: {}\n\
                ---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ../../x\n\
                ---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: b\n";

    let results = core.resource_apply(&id, yaml, "default").await.unwrap();

    let oks: Vec<bool> = results.iter().map(|r| r.ok).collect();
    assert_eq!(oks, [false, false, false, true]);
    assert!(
        results[0].message.contains("kind"),
        "{}",
        results[0].message
    );
    assert!(
        results[1].message.contains("name"),
        "{}",
        results[1].message
    );
    assert!(
        results[2].message.contains("name"),
        "{}",
        results[2].message
    );
}

#[tokio::test]
async fn apply_finds_a_kind_served_after_connecting_with_one_refresh() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.serve_resource(FakeResource::new(
        "example.com",
        "v1",
        "Widget",
        "widgets",
        true,
    ));
    let yaml = "apiVersion: example.com/v1\nkind: Widget\nmetadata:\n  name: w\n";

    let results = core.resource_apply(&id, yaml, "default").await.unwrap();

    assert!(results[0].ok, "{:?}", results[0]);
    let served = core.resources_discover(&id, false).await.unwrap();
    assert!(served.iter().any(|r| r.resource.plural == "widgets"));
}

#[tokio::test]
async fn apply_refreshes_discovery_once_for_an_unknown_kind_without_a_crd() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    let before = fake.request_count("/apis");
    let started = Instant::now();

    let results = core
        .resource_apply(
            &id,
            "apiVersion: example.com/v1\nkind: Gadget\nmetadata:\n  name: g\n",
            "default",
        )
        .await
        .unwrap();

    assert!(!results[0].ok);
    assert_eq!(fake.request_count("/apis"), before + 1);
    assert!(started.elapsed() < Duration::from_secs(5));
}

const CRD_THEN_WIDGET: &str = "apiVersion: apiextensions.k8s.io/v1\n\
    kind: CustomResourceDefinition\n\
    metadata:\n  name: widgets.example.com\n\
    ---\n\
    apiVersion: example.com/v1\nkind: Widget\nmetadata:\n  name: w\n";

#[tokio::test]
async fn apply_waits_for_the_kind_of_a_crd_it_created() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    let fake = Arc::new(fake);
    let serving = fake.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(1200)).await;
        serving.serve_resource(FakeResource::new(
            "example.com",
            "v1",
            "Widget",
            "widgets",
            true,
        ));
    });

    let results = core
        .resource_apply(&id, CRD_THEN_WIDGET, "default")
        .await
        .unwrap();

    assert!(results[0].ok, "{:?}", results[0]);
    assert!(results[1].ok, "{:?}", results[1]);
    assert_eq!(results[1].namespace.as_deref(), Some("default"));
    let served = core.resources_discover(&id, false).await.unwrap();
    assert!(served.iter().any(|r| r.resource.plural == "widgets"));
}

#[tokio::test]
async fn apply_gives_up_on_the_kind_of_a_crd_after_ten_seconds() {
    let (core, _fake, id, _root) = connected(FakeKubeConfig::default()).await;
    let started = Instant::now();

    let results = core
        .resource_apply(&id, CRD_THEN_WIDGET, "default")
        .await
        .unwrap();

    assert!(results[0].ok, "{:?}", results[0]);
    assert!(!results[1].ok);
    assert_eq!(
        results[1].message,
        r#"unknown kind "Widget" in apiVersion "example.com/v1""#
    );
    let elapsed = started.elapsed();
    assert!(elapsed >= Duration::from_secs(9), "{elapsed:?}");
    assert!(elapsed < Duration::from_secs(13), "{elapsed:?}");
}

#[tokio::test]
async fn apply_shows_the_discovery_error_when_the_crd_window_ends() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.fail_discovery_with(Some(500));

    let results = core
        .resource_apply(&id, CRD_THEN_WIDGET, "default")
        .await
        .unwrap();

    assert!(results[0].ok, "{:?}", results[0]);
    assert!(!results[1].ok);
    assert!(
        results[1].message.contains("injected failure"),
        "{}",
        results[1].message
    );
    assert!(
        !results[1].message.contains("unknown kind"),
        "{}",
        results[1].message
    );
}

#[tokio::test]
async fn apply_blames_the_kind_when_discovery_recovers_in_the_crd_window() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    let fake = Arc::new(fake);
    fake.fail_discovery_with(Some(500));
    let recovering = fake.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(1200)).await;
        recovering.fail_discovery_with(None);
    });

    let results = core
        .resource_apply(&id, CRD_THEN_WIDGET, "default")
        .await
        .unwrap();

    assert_eq!(
        results[1].message,
        r#"unknown kind "Widget" in apiVersion "example.com/v1""#
    );
}

#[tokio::test]
async fn apply_keeps_waiting_through_a_discovery_failure_in_the_crd_window() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    let fake = Arc::new(fake);
    fake.fail_discovery_with(Some(503));
    let recovering = fake.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(1200)).await;
        recovering.serve_resource(FakeResource::new(
            "example.com",
            "v1",
            "Widget",
            "widgets",
            true,
        ));
        recovering.fail_discovery_with(None);
    });

    let results = core
        .resource_apply(&id, CRD_THEN_WIDGET, "default")
        .await
        .unwrap();

    assert!(results[1].ok, "{:?}", results[1]);
}

#[tokio::test]
async fn apply_stops_waiting_for_a_kind_once_the_cluster_is_disconnected() {
    let (core, _fake, id, _root) = connected(FakeKubeConfig::default()).await;
    let yaml = format!(
        "{CRD_THEN_WIDGET}---\napiVersion: example.com/v1\nkind: Gadget\nmetadata:\n  name: g\n"
    );
    let disconnecting = core.clone();
    let disconnected_id = id.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(700)).await;
        disconnecting
            .cluster_disconnect(&disconnected_id)
            .await
            .unwrap();
    });
    let started = Instant::now();

    let results = core.resource_apply(&id, &yaml, "default").await.unwrap();

    assert!(results[0].ok, "{:?}", results[0]);
    for result in &results[1..] {
        assert!(!result.ok);
        assert!(
            result.message.contains("is not connected"),
            "{}",
            result.message
        );
    }
    let elapsed = started.elapsed();
    assert!(elapsed < Duration::from_secs(5), "{elapsed:?}");
}

#[tokio::test]
async fn apply_rejects_identity_fields_that_are_not_strings() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    let yaml = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\n  namespace: 123\n\
                ---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\n  namespace: true\n\
                ---\napiVersion: v1\nkind: Namespace\nmetadata:\n  name: fresh\n  namespace: 123\n\
                ---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: 123\n\
                ---\napiVersion: v1\nkind: 123\nmetadata:\n  name: a\n\
                ---\napiVersion: 1\nkind: ConfigMap\nmetadata:\n  name: a\n";
    let fields = [
        "metadata.namespace",
        "metadata.namespace",
        "metadata.namespace",
        "metadata.name",
        "kind",
        "apiVersion",
    ];

    let results = core.resource_apply(&id, yaml, "default").await.unwrap();

    assert_eq!(results.len(), fields.len());
    for (result, field) in results.iter().zip(fields) {
        assert!(!result.ok, "{result:?}");
        assert!(
            result
                .message
                .starts_with(&format!("{field} must be a string")),
            "{}",
            result.message
        );
    }
    assert_eq!(results[0].name.as_deref(), Some("a"));
    assert_eq!(results[0].namespace, None);
    assert!(fake
        .writes("PATCH", "/api/v1/namespaces/default/configmaps/a")
        .is_empty());
    assert!(fake.writes("PATCH", "/api/v1/namespaces/fresh").is_empty());
}

#[tokio::test]
async fn apply_uses_the_default_namespace_only_when_none_is_given() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    let yaml = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: quoted\n  namespace: \"123\"\n\
                ---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: null-ns\n  namespace: null\n\
                ---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: empty-ns\n  namespace: \"\"\n";

    let results = core.resource_apply(&id, yaml, "default").await.unwrap();

    let namespaces: Vec<Option<&str>> = results.iter().map(|r| r.namespace.as_deref()).collect();
    assert_eq!(
        namespaces,
        [Some("123"), Some("default"), Some("default")],
        "{results:?}"
    );
    assert!(results.iter().all(|r| r.ok), "{results:?}");
    assert_eq!(
        fake.writes("PATCH", "/api/v1/namespaces/123/configmaps/quoted")
            .len(),
        1
    );
}

#[tokio::test]
async fn apply_with_invalid_yaml_is_an_error() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    let yaml = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: first\n\
                ---\ndata: [tok-SECRET-value\n";

    let err = core.resource_apply(&id, yaml, "default").await.unwrap_err();

    assert_eq!(err.code, ErrorCode::InvalidInput);
    assert!(err.message.contains("line "), "{}", err.message);
    assert!(!err.message.contains("tok-SECRET"), "{}", err.message);
    assert!(fake
        .writes("PATCH", "/api/v1/namespaces/default/configmaps/first")
        .is_empty());
}

#[tokio::test]
async fn apply_rejects_a_document_that_is_not_a_mapping() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    let yaml = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: first\n---\ntok-SECRET-text\n";

    let err = core.resource_apply(&id, yaml, "default").await.unwrap_err();

    assert_eq!(err.code, ErrorCode::InvalidInput);
    assert!(!err.message.contains("tok-SECRET"), "{}", err.message);
    assert!(fake
        .writes("PATCH", "/api/v1/namespaces/default/configmaps/first")
        .is_empty());
}

#[tokio::test]
async fn apply_sends_merged_fields_and_no_merge_key() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    let yaml = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: app\n\
                x-base: &base {shared: from-base, kept: base}\n\
                data:\n  <<: *base\n  shared: explicit\n";

    let results = core.resource_apply(&id, yaml, "default").await.unwrap();

    assert!(results[0].ok, "{:?}", results[0]);
    let writes = fake.writes("PATCH", CONFIGMAP_PATH);
    assert_eq!(
        writes[0].body["data"],
        json!({ "shared": "explicit", "kept": "base" })
    );
}

#[tokio::test]
async fn apply_with_a_merge_key_that_is_not_a_mapping_applies_nothing() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    let yaml = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: one\n\
                ---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: two\n\
                data:\n  <<: tok-SECRET\n";

    let err = core.resource_apply(&id, yaml, "default").await.unwrap_err();

    assert_eq!(err.code, ErrorCode::InvalidInput);
    assert!(err.message.contains("line"), "{}", err.message);
    assert!(!err.message.contains("tok-SECRET"), "{}", err.message);
    assert!(fake.writes("PATCH", CONFIGMAP_PATH).is_empty());
}

#[tokio::test]
async fn replace_sends_merged_fields_and_no_merge_key() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    upsert_configmap(&fake, "first");
    let yaml = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: app\n  namespace: default\n\
                x-base: &base {kept: base}\ndata:\n  <<: *base\n";

    let stored = core
        .resource_replace(&id, &configmaps(), Some("default"), "app", yaml, true)
        .await
        .unwrap();

    assert_eq!(stored["data"], json!({ "kept": "base" }));
}

#[tokio::test]
async fn apply_uses_field_manager_sextant() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    let yaml = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: app\n";

    let results = core.resource_apply(&id, yaml, "default").await.unwrap();

    assert!(results[0].ok, "{:?}", results[0]);
    let writes = fake.writes("PATCH", CONFIGMAP_PATH);
    assert_eq!(writes.len(), 1);
    assert_eq!(
        writes[0].query.get("fieldManager").map(String::as_str),
        Some("sextant")
    );
    assert!(!writes[0].query.contains_key("force"));
    assert_eq!(writes[0].body["metadata"]["namespace"], "default");
}

#[tokio::test]
async fn apply_forbidden_document_shows_server_message() {
    let (core, _fake, id, _root) = connected(FakeKubeConfig {
        deny: vec![DenyRule {
            verb: "create".into(),
            plural: "configmaps".into(),
            namespace: None,
        }],
        ..Default::default()
    })
    .await;
    let yaml = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: app\n";

    let results = core.resource_apply(&id, yaml, "default").await.unwrap();

    assert!(!results[0].ok);
    assert!(
        results[0]
            .message
            .contains(r#"cannot create resource "configmaps""#),
        "{}",
        results[0].message
    );
}

#[tokio::test]
async fn delete_passes_propagation_policy() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    upsert_configmap(&fake, "first");

    core.resource_delete(
        &id,
        &configmaps(),
        Some("default"),
        "app",
        Propagation::Foreground,
    )
    .await
    .unwrap();

    let writes = fake.writes("DELETE", CONFIGMAP_PATH);
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].body["propagationPolicy"], "Foreground");
    let gone = core
        .resource_get(&id, &configmaps(), Some("default"), "app")
        .await
        .unwrap_err();
    assert_eq!(gone.code, ErrorCode::NotFound);
}

#[tokio::test]
async fn delete_not_found_is_an_error() {
    let (core, _fake, id, _root) = connected(FakeKubeConfig::default()).await;

    let err = core
        .resource_delete(
            &id,
            &configmaps(),
            Some("default"),
            "missing",
            Propagation::default(),
        )
        .await
        .unwrap_err();

    assert_eq!(err.code, ErrorCode::NotFound);
}

#[tokio::test]
async fn operations_on_a_namespaced_resource_need_a_valid_namespace_and_name() {
    let (core, _fake, id, _root) = connected(FakeKubeConfig::default()).await;

    for (namespace, name) in [(None, "app"), (Some("a/b"), "app"), (Some("default"), "..")] {
        let err = core
            .resource_get(&id, &configmaps(), namespace, name)
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidInput, "{namespace:?} {name}");
    }
}

fn event(name: &str, object: &str, last_seen: &str) -> Value {
    json!({
        "metadata": {
            "name": name,
            "namespace": "default",
            "managedFields": [{ "manager": "m" }],
        },
        "involvedObject": { "kind": "Pod", "namespace": "default", "name": object },
        "reason": "Started",
        "lastTimestamp": last_seen,
    })
}

fn pod_ref(name: &str) -> InvolvedRef {
    InvolvedRef {
        kind: "Pod".into(),
        namespace: Some("default".into()),
        name: name.into(),
        uid: None,
    }
}

#[tokio::test]
async fn events_are_filtered_and_newest_first() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.upsert("events", event("old", "p", "2026-01-01T00:00:00Z"));
    fake.upsert("events", event("other", "q", "2026-01-03T00:00:00Z"));
    fake.upsert("events", event("new", "p", "2026-01-02T00:00:00Z"));

    let events = core.resource_events(&id, &pod_ref("p")).await.unwrap();

    let names: Vec<&str> = events
        .iter()
        .map(|e| e["metadata"]["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["new", "old"]);
    assert!(events[0]["metadata"].get("managedFields").is_none());
}

#[tokio::test]
async fn events_compare_times_of_different_precision() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.upsert("events", event("whole", "p", "2026-01-01T00:00:00Z"));
    let mut micro = event("micro", "p", "");
    micro.as_object_mut().unwrap().remove("lastTimestamp");
    micro["eventTime"] = json!("2026-01-01T00:00:00.500000Z");
    fake.upsert("events", micro);

    let events = core.resource_events(&id, &pod_ref("p")).await.unwrap();

    assert_eq!(events[0]["metadata"]["name"], "micro");
}

#[tokio::test]
async fn events_return_at_most_one_hundred() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    for i in 0..105 {
        let time = format!("2026-01-01T00:{:02}:{:02}Z", i / 60, i % 60);
        fake.upsert("events", event(&format!("e{i}"), "p", &time));
    }

    let events = core.resource_events(&id, &pod_ref("p")).await.unwrap();

    assert_eq!(events.len(), 100);
    assert_eq!(events[0]["metadata"]["name"], "e104");
    assert_eq!(events[99]["metadata"]["name"], "e5");
}
