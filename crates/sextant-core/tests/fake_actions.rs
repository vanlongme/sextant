//! Workload, pod, node, Secret and ConfigMap actions against the fake API server.
//! Every kubeconfig lives in a temp `<home>/.kube`; `KUBECONFIG` is never read.

use std::time::{Duration, Instant};

use serde_json::{json, Value};
use sextant_core::app_core::AppCore;
use sextant_core::cluster::ConnectionState;
use sextant_core::error::ErrorCode;
use sextant_core::kubeconfig::ClusterId;
use sextant_core::paths::AppPaths;
use sextant_core::resources::{DataChange, ResourceRef};
use sextant_fakekube::{DenyRule, FakeKube, FakeKubeConfig, FakeResource};
use tempfile::TempDir;

const CONTEXT: &str = "fake";

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

fn deployments() -> ResourceRef {
    ResourceRef {
        group: "apps".into(),
        version: "v1".into(),
        plural: "deployments".into(),
        kind: "Deployment".into(),
        namespaced: true,
    }
}

fn deployment_json(namespace: &str, name: &str, replicas: i32) -> Value {
    json!({ "metadata": { "name": name, "namespace": namespace }, "spec": { "replicas": replicas } })
}

fn upsert_secret(fake: &FakeKube, data: Value) {
    fake.upsert(
        "secrets",
        json!({ "metadata": { "name": "s", "namespace": "default" }, "data": data }),
    );
}

async fn version_of(core: &AppCore, id: &ClusterId, r: &ResourceRef, name: &str) -> String {
    let object = core
        .resource_get(id, r, Some("default"), name)
        .await
        .unwrap();
    object["metadata"]["resourceVersion"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[tokio::test]
async fn scale_patches_the_scale_subresource() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.upsert("deployments", deployment_json("default", "web", 1));
    core.workload_scale(&id, &deployments(), "default", "web", 3)
        .await
        .unwrap();
    let writes = fake.writes(
        "PATCH",
        "/apis/apps/v1/namespaces/default/deployments/web/scale",
    );
    assert_eq!(writes[0].body, json!({ "spec": { "replicas": 3 } }));
}

#[tokio::test]
async fn scale_rejects_a_negative_count() {
    let (core, _fake, id, _root) = connected(FakeKubeConfig::default()).await;
    let error = core
        .workload_scale(&id, &deployments(), "default", "web", -1)
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
}

#[tokio::test]
async fn restart_sets_the_restarted_at_annotation() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.upsert("deployments", deployment_json("default", "web", 1));
    core.workload_restart(&id, &deployments(), "default", "web")
        .await
        .unwrap();
    let writes = fake.writes("PATCH", "/apis/apps/v1/namespaces/default/deployments/web");
    let stamp = writes[0]
        .body
        .pointer("/spec/template/metadata/annotations/kubectl.kubernetes.io~1restartedAt");
    assert!(stamp
        .and_then(Value::as_str)
        .is_some_and(|s| s.ends_with('Z')));
}

#[tokio::test]
async fn restart_refuses_a_kind_with_no_rollout() {
    let (core, _fake, id, _root) = connected(FakeKubeConfig::default()).await;
    let replica_sets = ResourceRef {
        plural: "replicasets".into(),
        kind: "ReplicaSet".into(),
        ..deployments()
    };
    let error = core
        .workload_restart(&id, &replica_sets, "default", "web")
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
}

#[tokio::test]
async fn evict_posts_a_policy_v1_eviction() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.add_pod("default", "p");
    core.pod_evict(&id, "default", "p").await.unwrap();
    let writes = fake.writes("POST", "/api/v1/namespaces/default/pods/p/eviction");
    assert_eq!(
        writes[0].body,
        json!({ "apiVersion": "policy/v1", "kind": "Eviction", "metadata": { "name": "p", "namespace": "default" } }),
    );
}

#[tokio::test]
async fn evict_shows_the_disruption_budget_message() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.add_pod("default", "p");
    fake.fail_evictions_with("default", "p", 429, None);
    let error = core.pod_evict(&id, "default", "p").await.unwrap_err();
    assert!(
        error.message.contains("disruption budget"),
        "{}",
        error.message
    );
}

#[tokio::test]
async fn a_forbidden_action_shows_the_api_message() {
    let config = FakeKubeConfig {
        deny: vec![DenyRule {
            verb: "patch".into(),
            plural: "deployments/scale".into(),
            namespace: None,
        }],
        ..Default::default()
    };
    let (core, fake, id, _root) = connected(config).await;
    fake.upsert("deployments", deployment_json("default", "web", 1));
    let error = core
        .workload_scale(&id, &deployments(), "default", "web", 2)
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Forbidden);
    assert!(error.message.contains("forbidden"), "{}", error.message);
}

#[tokio::test]
async fn trigger_builds_a_job_from_the_template() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.serve_resource(FakeResource::new(
        "batch", "v1", "CronJob", "cronjobs", true,
    ));
    fake.serve_resource(FakeResource::new("batch", "v1", "Job", "jobs", true));
    fake.upsert(
        "cronjobs",
        json!({
            "metadata": { "name": "tick", "namespace": "default", "uid": "u1" },
            "spec": { "schedule": "* * * * *", "jobTemplate": {
                "metadata": { "labels": { "team": "a" }, "annotations": { "note": "n" } },
                "spec": { "template": { "spec": { "containers": [] } } },
            } },
        }),
    );
    let name = core.cronjob_trigger(&id, "default", "tick").await.unwrap();
    assert!(
        name.starts_with("tick-manual-") && name.len() <= 63,
        "{name}"
    );
    let writes = fake.writes("POST", "/apis/batch/v1/namespaces/default/jobs");
    let body = &writes[0].body;
    assert_eq!(body["metadata"]["name"], name.as_str());
    assert_eq!(body["metadata"]["labels"]["team"], "a");
    assert_eq!(body["metadata"]["annotations"]["note"], "n");
    assert_eq!(
        body["metadata"]["annotations"]["cronjob.kubernetes.io/instantiate"],
        "manual"
    );
    assert_eq!(
        body["metadata"]["ownerReferences"][0],
        json!({
            "apiVersion": "batch/v1", "kind": "CronJob", "name": "tick", "uid": "u1",
            "controller": true, "blockOwnerDeletion": true,
        })
    );
    assert_eq!(body["spec"]["template"]["spec"]["containers"], json!([]));
}

#[tokio::test]
async fn suspend_and_resume_patch_the_spec() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.serve_resource(FakeResource::new(
        "batch", "v1", "CronJob", "cronjobs", true,
    ));
    fake.upsert(
        "cronjobs",
        json!({ "metadata": { "name": "tick", "namespace": "default" }, "spec": {} }),
    );
    core.cronjob_set_suspend(&id, "default", "tick", true)
        .await
        .unwrap();
    core.cronjob_set_suspend(&id, "default", "tick", false)
        .await
        .unwrap();
    let writes = fake.writes("PATCH", "/apis/batch/v1/namespaces/default/cronjobs/tick");
    assert_eq!(writes[0].body, json!({ "spec": { "suspend": true } }));
    assert_eq!(writes[1].body, json!({ "spec": { "suspend": false } }));
}

#[tokio::test]
async fn cordon_and_uncordon_patch_unschedulable() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.upsert("nodes", json!({ "metadata": { "name": "n1" } }));
    core.node_set_unschedulable(&id, "n1", true).await.unwrap();
    core.node_set_unschedulable(&id, "n1", false).await.unwrap();
    let writes = fake.writes("PATCH", "/api/v1/nodes/n1");
    assert_eq!(writes[0].body, json!({ "spec": { "unschedulable": true } }));
    assert_eq!(writes[1].body, json!({ "spec": { "unschedulable": null } }));
}

#[tokio::test]
async fn secret_reveal_returns_one_key_only() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    upsert_secret(&fake, json!({ "a": "dmFsdWU=", "b": "b3RoZXI=" }));
    let value = core.secret_reveal(&id, "default", "s", "a").await.unwrap();
    assert_eq!(value.value, "value");
    assert!(!value.binary);
    assert!(!serde_json::to_string(&value).unwrap().contains("other"));
}

#[tokio::test]
async fn secret_reveal_marks_a_binary_value() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    upsert_secret(&fake, json!({ "a": "/w==" })); // 0xFF is not UTF-8
    let value = core.secret_reveal(&id, "default", "s", "a").await.unwrap();
    assert!(value.binary);
    assert_eq!(value.value, "/w==");
}

#[tokio::test]
async fn secret_reveal_of_a_missing_key_is_not_found() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    upsert_secret(&fake, json!({ "other": "dmFsdWU=" }));
    let error = core
        .secret_reveal(&id, "default", "s", "a")
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::NotFound);
    assert!(
        !error.message.contains("dmFsdWU=") && !error.message.contains("other"),
        "{}",
        error.message
    );
}

#[tokio::test]
async fn secret_update_encodes_values_and_removes_keys() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    upsert_secret(&fake, json!({ "a": "eA==", "gone": "eQ==" }));
    let version = version_of(&core, &id, &secrets(), "s").await;
    core.secret_update(
        &id,
        "default",
        "s",
        &version,
        vec![
            DataChange {
                key: "a".into(),
                value: Some("value".into()),
            },
            DataChange {
                key: "gone".into(),
                value: None,
            },
        ],
    )
    .await
    .unwrap();
    let writes = fake.writes("PATCH", "/api/v1/namespaces/default/secrets/s");
    assert_eq!(
        writes[0].body,
        json!({
            "metadata": { "resourceVersion": version },
            "data": { "a": "dmFsdWU=", "gone": null },
        })
    );
}

#[tokio::test]
async fn secret_update_conflict_changes_nothing() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    upsert_secret(&fake, json!({ "a": "eA==" }));
    let stale = version_of(&core, &id, &secrets(), "s").await;
    upsert_secret(&fake, json!({ "a": "eA==" })); // Someone else saved in between.
    let error = core
        .secret_update(
            &id,
            "default",
            "s",
            &stale,
            vec![DataChange {
                key: "a".into(),
                value: Some("S3CRET".into()),
            }],
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict);
    assert!(!error.message.contains("S3CRET"));
    assert_eq!(
        core.secret_reveal(&id, "default", "s", "a")
            .await
            .unwrap()
            .value,
        "x"
    );
}

#[tokio::test]
async fn update_without_a_resource_version_is_refused() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    let change = || {
        vec![DataChange {
            key: "a".into(),
            value: Some("x".into()),
        }]
    };
    let secret = core
        .secret_update(&id, "default", "s", "", change())
        .await
        .unwrap_err();
    let map = core
        .configmap_update(&id, "default", "c", "", change())
        .await
        .unwrap_err();
    assert_eq!(secret.code, ErrorCode::InvalidInput);
    assert_eq!(map.code, ErrorCode::InvalidInput);
    assert!(fake
        .writes("PATCH", "/api/v1/namespaces/default/secrets/s")
        .is_empty());
    assert!(fake
        .writes("PATCH", "/api/v1/namespaces/default/configmaps/c")
        .is_empty());
}

#[tokio::test]
async fn configmap_update_patches_only_data() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.upsert(
        "configmaps",
        json!({ "metadata": { "name": "c", "namespace": "default" }, "data": { "a": "1" } }),
    );
    let version = version_of(&core, &id, &configmaps(), "c").await;
    core.configmap_update(
        &id,
        "default",
        "c",
        &version,
        vec![DataChange {
            key: "a".into(),
            value: Some("2".into()),
        }],
    )
    .await
    .unwrap();
    let writes = fake.writes("PATCH", "/api/v1/namespaces/default/configmaps/c");
    assert_eq!(
        writes[0].body,
        json!({ "metadata": { "resourceVersion": version }, "data": { "a": "2" } })
    );
}

fn ingress_classes() -> FakeResource {
    FakeResource::new(
        "networking.k8s.io",
        "v1",
        "IngressClass",
        "ingressclasses",
        false,
    )
}

const DEFAULT_CLASS: &str = "ingressclass.kubernetes.io/is-default-class";
const CLASSES_PATH: &str = "/apis/networking.k8s.io/v1/ingressclasses";

fn add_class(fake: &FakeKube, name: &str, is_default: bool) {
    let annotations = if is_default {
        json!({ DEFAULT_CLASS: "true" })
    } else {
        json!({ "keep": "me" })
    };
    fake.upsert(
        "ingressclasses",
        json!({ "metadata": { "name": name, "annotations": annotations } }),
    );
}

fn pods() -> ResourceRef {
    ResourceRef {
        group: String::new(),
        version: "v1".into(),
        plural: "pods".into(),
        kind: "Pod".into(),
        namespaced: true,
    }
}

async fn pod_uid(core: &AppCore, id: &ClusterId, name: &str) -> String {
    let pod = core
        .resource_get(id, &pods(), Some("default"), name)
        .await
        .unwrap();
    pod["metadata"]["uid"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn force_delete_sends_a_grace_period_of_zero_and_the_uid() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.add_pod("default", "p");
    let uid = pod_uid(&core, &id, "p").await;
    core.pod_force_delete(&id, "default", "p", &uid)
        .await
        .unwrap();
    let delete = fake
        .writes("DELETE", "/api/v1/namespaces/default/pods/p")
        .pop()
        .unwrap();
    assert_eq!(delete.body["gracePeriodSeconds"], 0);
    assert_eq!(delete.body["preconditions"]["uid"], uid.as_str());
    let error = core
        .pod_force_delete(&id, "default", "p", &uid)
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::NotFound);
}

/// A row read before a StatefulSet replaced its pod still holds the old uid, and the
/// replacement has the same name.
#[tokio::test]
async fn force_delete_leaves_a_replacement_with_the_same_name() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.add_pod("default", "p");
    let stale = pod_uid(&core, &id, "p").await;
    fake.delete_pod("default", "p");
    fake.add_pod("default", "p");
    let error = core
        .pod_force_delete(&id, "default", "p", &stale)
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict);
    assert_ne!(pod_uid(&core, &id, "p").await, stale);
}

fn config_maps() -> ResourceRef {
    ResourceRef {
        group: String::new(),
        version: "v1".into(),
        plural: "configmaps".into(),
        kind: "ConfigMap".into(),
        namespaced: true,
    }
}

#[tokio::test]
async fn force_finalize_is_refused_unless_the_object_is_being_deleted() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.upsert(
        "configmaps",
        json!({ "metadata": { "name": "c", "namespace": "default", "finalizers": ["x/y"] } }),
    );
    let error = core
        .resource_force_finalize(&id, &config_maps(), Some("default"), "c")
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
    assert!(fake
        .writes("PATCH", "/api/v1/namespaces/default/configmaps/c")
        .is_empty());
}

#[tokio::test]
async fn force_finalize_clears_the_finalizers_of_the_object_it_read() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.upsert(
        "configmaps",
        json!({ "metadata": {
            "name": "c", "namespace": "default", "finalizers": ["x/y"],
            "deletionTimestamp": "2026-01-01T00:00:00Z",
        } }),
    );
    core.resource_force_finalize(&id, &config_maps(), Some("default"), "c")
        .await
        .unwrap();
    let patch = fake
        .writes("PATCH", "/api/v1/namespaces/default/configmaps/c")
        .pop()
        .unwrap();
    assert!(patch.body["metadata"]["finalizers"].is_null());
    assert!(patch.body["metadata"]
        .as_object()
        .unwrap()
        .contains_key("finalizers"));
    let current = core
        .resource_get(&id, &config_maps(), Some("default"), "c")
        .await
        .unwrap();
    assert_eq!(current["metadata"]["uid"], patch.body["metadata"]["uid"]);
    assert!(current["metadata"].get("finalizers").is_none());
}

#[tokio::test]
async fn job_suspend_and_resume_patch_the_spec() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.serve_resource(FakeResource::new("batch", "v1", "Job", "jobs", true));
    fake.upsert(
        "jobs",
        json!({ "metadata": { "name": "j", "namespace": "default" } }),
    );
    core.job_set_suspend(&id, "default", "j", true)
        .await
        .unwrap();
    core.job_set_suspend(&id, "default", "j", false)
        .await
        .unwrap();
    let path = "/apis/batch/v1/namespaces/default/jobs/j";
    let patches = fake.writes("PATCH", path);
    assert_eq!(patches[0].body, json!({ "spec": { "suspend": true } }));
    assert_eq!(patches[1].body, json!({ "spec": { "suspend": false } }));
}

#[tokio::test]
async fn setting_a_default_class_moves_the_annotation() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.serve_resource(ingress_classes());
    add_class(&fake, "old", true);
    add_class(&fake, "new", false);
    add_class(&fake, "other", false);
    core.ingress_class_set_default(&id, "new").await.unwrap();
    let patch = |name: &str| fake.writes("PATCH", &format!("{CLASSES_PATH}/{name}"));
    assert_eq!(patch("new").len(), 1);
    assert_eq!(patch("old").len(), 1);
    assert!(patch("old")[0].body["metadata"]["annotations"][DEFAULT_CLASS].is_null());
    // A class without the annotation is not written to.
    assert!(patch("other").is_empty());
}

#[tokio::test]
async fn a_failure_on_the_chosen_class_changes_nothing_else() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.serve_resource(ingress_classes());
    add_class(&fake, "old", true);
    add_class(&fake, "new", false);
    fake.fail_writes_to("ingressclasses", "new", Some(403));
    let error = core
        .ingress_class_set_default(&id, "new")
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Forbidden);
    assert!(fake
        .writes("PATCH", &format!("{CLASSES_PATH}/old"))
        .is_empty());
}

#[tokio::test]
async fn a_partial_failure_names_the_classes_left_unchanged() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    fake.serve_resource(ingress_classes());
    add_class(&fake, "old-one", true);
    add_class(&fake, "old-two", true);
    add_class(&fake, "new", false);
    fake.fail_writes_to("ingressclasses", "old-two", Some(403));
    let error = core
        .ingress_class_set_default(&id, "new")
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Forbidden);
    assert!(error.message.contains("old-two"), "{}", error.message);
    assert!(!error.message.contains("old-one"), "{}", error.message);
    // The rest of the work still happened.
    assert_eq!(
        fake.writes("PATCH", &format!("{CLASSES_PATH}/old-one"))
            .len(),
        1
    );
}

const TOKEN_PATH: &str = "/api/v1/namespaces/default/serviceaccounts/sa/token";

fn add_service_account(fake: &FakeKube) {
    fake.serve_resource(FakeResource::new(
        "",
        "v1",
        "ServiceAccount",
        "serviceaccounts",
        true,
    ));
    fake.upsert(
        "serviceaccounts",
        json!({ "metadata": { "name": "sa", "namespace": "default" } }),
    );
}

#[tokio::test]
async fn a_service_account_kubeconfig_holds_the_token_and_only_the_file_does() {
    let (core, fake, id, root) = connected(FakeKubeConfig::default()).await;
    add_service_account(&fake);
    let dest = root.path().join("sa.kubeconfig");
    let saved = core
        .service_account_kubeconfig_save(&id, "default", "sa", &dest, None)
        .await
        .unwrap();
    assert_eq!(saved.expires_at, "2030-01-01T00:00:00Z");
    // The token stays off IPC, whichever way the result is written out.
    let returned = serde_json::to_string(&saved).unwrap();
    assert!(!returned.contains("fake-token"), "{returned}");
    assert!(!format!("{saved:?}").contains("fake-token"));

    let text = std::fs::read_to_string(&dest).unwrap();
    let document: Value = serde_yaml_ng::from_str(&text).unwrap();
    assert_eq!(document["users"][0]["user"]["token"], "fake-token-sa");
    assert_eq!(document["current-context"], "sa@default");
    assert_eq!(document["clusters"][0]["cluster"]["server"], fake.url());

    let request = fake.writes("POST", TOKEN_PATH).pop().unwrap();
    assert_eq!(request.body["spec"]["expirationSeconds"], 3600);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&dest).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}

#[tokio::test]
async fn a_chosen_lifetime_is_requested() {
    let (core, fake, id, root) = connected(FakeKubeConfig::default()).await;
    add_service_account(&fake);
    let dest = root.path().join("sa.kubeconfig");
    core.service_account_kubeconfig_save(&id, "default", "sa", &dest, Some(7200))
        .await
        .unwrap();
    let request = fake.writes("POST", TOKEN_PATH).pop().unwrap();
    assert_eq!(request.body["spec"]["expirationSeconds"], 7200);
}

#[tokio::test]
async fn a_bad_destination_spends_no_token() {
    let (core, fake, id, root) = connected(FakeKubeConfig::default()).await;
    add_service_account(&fake);
    for dest in [
        std::path::PathBuf::from("relative.kubeconfig"),
        root.path().join("missing").join("sa.kubeconfig"),
    ] {
        let error = core
            .service_account_kubeconfig_save(&id, "default", "sa", &dest, None)
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput, "{dest:?}");
    }
    assert!(fake.writes("POST", TOKEN_PATH).is_empty());
}

#[tokio::test]
async fn a_missing_service_account_rejects_and_writes_nothing() {
    let (core, fake, id, root) = connected(FakeKubeConfig::default()).await;
    fake.serve_resource(FakeResource::new(
        "",
        "v1",
        "ServiceAccount",
        "serviceaccounts",
        true,
    ));
    let dest = root.path().join("sa.kubeconfig");
    let error = core
        .service_account_kubeconfig_save(&id, "default", "sa", &dest, None)
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::NotFound);
    assert!(!dest.exists());
}

#[cfg(unix)]
#[tokio::test]
async fn an_unwritable_destination_folder_is_refused_without_quoting_it() {
    use std::os::unix::fs::PermissionsExt;
    let (core, fake, id, root) = connected(FakeKubeConfig::default()).await;
    add_service_account(&fake);
    let folder = root.path().join("readonly-folder");
    std::fs::create_dir(&folder).unwrap();
    std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o555)).unwrap();
    let dest = folder.join("sa.kubeconfig");
    let result = core
        .service_account_kubeconfig_save(&id, "default", "sa", &dest, None)
        .await;
    std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o755)).unwrap();
    // A superuser can write anywhere, so there is nothing to check then.
    if let Err(error) = result {
        let shown = format!("{} {:?}", error.message, error.details);
        assert!(!shown.contains("readonly-folder"), "{shown}");
    }
}
