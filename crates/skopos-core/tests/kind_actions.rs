//! Actions against the real `skopos-e2e` kind cluster.
//! Needs `make test-kind`. Only `e2e/.tmp/kubeconfig` is read, never a default one.

use std::panic::AssertUnwindSafe;
use std::path::Path;
use std::time::{Duration, Instant};

use futures::FutureExt;
use k8s_openapi::api::authentication::v1::TokenRequest;
use k8s_openapi::api::core::v1::{Namespace, ServiceAccount};
use kube::api::{DeleteParams, ListParams, ObjectMeta, PostParams};
use kube::{Api, Client};
use serde_json::{json, Value};
use skopos_core::app_core::AppCore;
use skopos_core::cluster::ConnectionState;
use skopos_core::error::ErrorCode;
use skopos_core::kubeconfig::ClusterId;
use skopos_core::paths::AppPaths;
use skopos_core::resources::{DataChange, ResourceRef};
use tempfile::TempDir;

const CONTEXT: &str = "kind-skopos-e2e";
const NAMESPACE: &str = "skopos-test-actions";
const WAIT: Duration = Duration::from_secs(90);

fn kind_kubeconfig() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../e2e/.tmp/kubeconfig")
}

async fn connect_with(kubeconfig: &str, context: &str) -> (AppCore, ClusterId, TempDir) {
    let root = tempfile::tempdir().unwrap();
    let kube_dir = root.path().join("home").join(".kube");
    std::fs::create_dir_all(&kube_dir).unwrap();
    std::fs::write(kube_dir.join("config"), kubeconfig).unwrap();
    let paths = AppPaths::under(&root.path().join("app"), &root.path().join("home"));
    let core = AppCore::start_with_kubeconfig_env(paths, None)
        .await
        .unwrap();
    let started = Instant::now();
    let id = loop {
        let found = core
            .catalog_list()
            .into_iter()
            .find(|entry| entry.context_name == context);
        if let Some(entry) = found {
            break entry.id;
        }
        assert!(started.elapsed() < WAIT, "no catalog entry");
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    let state = core.cluster_connect(&id).await.unwrap();
    assert!(
        matches!(state, ConnectionState::Connected { .. }),
        "{state:?}"
    );
    (core, id, root)
}

async fn connected() -> (AppCore, ClusterId, TempDir) {
    let text = std::fs::read_to_string(kind_kubeconfig()).unwrap();
    connect_with(&text, CONTEXT).await
}

/// Waits out a leftover from an earlier failed run, then creates the namespace.
async fn create_namespace(client: &Client) {
    let namespaces: Api<Namespace> = Api::all(client.clone());
    let _ = namespaces.delete(NAMESPACE, &DeleteParams::default()).await;
    let started = Instant::now();
    while namespaces.get_opt(NAMESPACE).await.unwrap().is_some() {
        assert!(started.elapsed() < WAIT, "still there");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let namespace = Namespace {
        metadata: ObjectMeta {
            name: Some(NAMESPACE.to_owned()),
            ..Default::default()
        },
        ..Default::default()
    };
    namespaces
        .create(&PostParams::default(), &namespace)
        .await
        .unwrap();
}

/// Runs `body`, removes the namespace whether or not it failed, then reports the failure.
async fn with_namespace<F>(client: &Client, body: F)
where
    F: std::future::Future<Output = ()>,
{
    create_namespace(client).await;
    let outcome = AssertUnwindSafe(body).catch_unwind().await;
    let namespaces: Api<Namespace> = Api::all(client.clone());
    let _ = namespaces.delete(NAMESPACE, &DeleteParams::default()).await;
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}

async fn eventually<F, Fut>(what: &str, check: F)
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let started = Instant::now();
    while !check().await {
        assert!(started.elapsed() < WAIT, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

fn resource(group: &str, plural: &str, kind: &str) -> ResourceRef {
    ResourceRef {
        group: group.into(),
        version: "v1".into(),
        plural: plural.into(),
        kind: kind.into(),
        namespaced: true,
    }
}

fn deployments() -> ResourceRef {
    resource("apps", "deployments", "Deployment")
}

async fn create<T>(client: &Client, value: Value)
where
    T: kube::Resource<Scope = kube::core::NamespaceResourceScope>
        + serde::Serialize
        + serde::de::DeserializeOwned
        + Clone
        + std::fmt::Debug,
    T::DynamicType: Default,
{
    let api: Api<T> = Api::namespaced(client.clone(), NAMESPACE);
    api.create(
        &PostParams::default(),
        &serde_json::from_value(value).unwrap(),
    )
    .await
    .unwrap();
}

fn deployment(name: &str, replicas: i32) -> Value {
    json!({
        "metadata": { "name": name },
        "spec": {
            "replicas": replicas,
            "selector": { "matchLabels": { "app": name } },
            "template": {
                "metadata": { "labels": { "app": name } },
                "spec": { "containers": [{ "name": "main", "image": "registry.k8s.io/pause:3.10" }] },
            },
        },
    })
}

async fn get(core: &AppCore, id: &ClusterId, r: &ResourceRef, name: &str) -> Value {
    core.resource_get(id, r, Some(NAMESPACE), name)
        .await
        .unwrap()
}

#[tokio::test]
#[ignore = "needs make test-kind"]
async fn scale_changes_the_replica_count() {
    let (core, id, _root) = connected().await;
    let client = core.cluster_client(&id).unwrap();
    with_namespace(&client, async {
        create::<k8s_openapi::api::apps::v1::Deployment>(&client, deployment("web", 1)).await;
        core.workload_scale(&id, &deployments(), NAMESPACE, "web", 2)
            .await
            .unwrap();
        let object = get(&core, &id, &deployments(), "web").await;
        assert_eq!(object["spec"]["replicas"], 2);
    })
    .await;
}

#[tokio::test]
#[ignore = "needs make test-kind"]
async fn restart_rolls_the_deployment() {
    let (core, id, _root) = connected().await;
    let client = core.cluster_client(&id).unwrap();
    with_namespace(&client, async {
        create::<k8s_openapi::api::apps::v1::Deployment>(&client, deployment("web", 1)).await;
        core.workload_restart(&id, &deployments(), NAMESPACE, "web")
            .await
            .unwrap();
        eventually("the restart annotation", || async {
            let object = get(&core, &id, &deployments(), "web").await;
            object
                .pointer("/spec/template/metadata/annotations/kubectl.kubernetes.io~1restartedAt")
                .is_some()
        })
        .await;
    })
    .await;
}

#[tokio::test]
#[ignore = "needs make test-kind"]
async fn evict_replaces_the_pod() {
    let (core, id, _root) = connected().await;
    let client = core.cluster_client(&id).unwrap();
    with_namespace(&client, async {
        create::<k8s_openapi::api::apps::v1::Deployment>(&client, deployment("web", 1)).await;
        let pods: Api<k8s_openapi::api::core::v1::Pod> = Api::namespaced(client.clone(), NAMESPACE);
        let names = || async {
            pods.list(&ListParams::default())
                .await
                .unwrap()
                .items
                .into_iter()
                .filter_map(|pod| pod.metadata.name)
                .collect::<Vec<_>>()
        };
        eventually("the first pod", || async { !names().await.is_empty() }).await;
        let first = names().await.remove(0);
        core.pod_evict(&id, NAMESPACE, &first).await.unwrap();
        eventually("another pod", || async {
            names().await.iter().any(|name| *name != first)
        })
        .await;
    })
    .await;
}

fn cronjob(name: &str) -> Value {
    json!({
        "metadata": { "name": name },
        "spec": {
            "schedule": "0 0 1 1 *",
            "jobTemplate": { "spec": { "template": { "spec": {
                "restartPolicy": "Never",
                "containers": [{ "name": "main", "image": "registry.k8s.io/pause:3.10" }],
            } } } },
        },
    })
}

#[tokio::test]
#[ignore = "needs make test-kind"]
async fn trigger_creates_an_owned_job() {
    let (core, id, _root) = connected().await;
    let client = core.cluster_client(&id).unwrap();
    with_namespace(&client, async {
        create::<k8s_openapi::api::batch::v1::CronJob>(&client, cronjob("tick")).await;
        let job_name = core.cronjob_trigger(&id, NAMESPACE, "tick").await.unwrap();
        let jobs = resource("batch", "jobs", "Job");
        let job = get(&core, &id, &jobs, &job_name).await;
        assert_eq!(job["metadata"]["ownerReferences"][0]["kind"], "CronJob");
        assert_eq!(
            job["metadata"]["annotations"]["cronjob.kubernetes.io/instantiate"],
            "manual"
        );
    })
    .await;
}

#[tokio::test]
#[ignore = "needs make test-kind"]
async fn suspend_is_stored() {
    let (core, id, _root) = connected().await;
    let client = core.cluster_client(&id).unwrap();
    with_namespace(&client, async {
        create::<k8s_openapi::api::batch::v1::CronJob>(&client, cronjob("tick")).await;
        let cronjobs = resource("batch", "cronjobs", "CronJob");
        core.cronjob_set_suspend(&id, NAMESPACE, "tick", true)
            .await
            .unwrap();
        assert_eq!(
            get(&core, &id, &cronjobs, "tick").await["spec"]["suspend"],
            true
        );
        core.cronjob_set_suspend(&id, NAMESPACE, "tick", false)
            .await
            .unwrap();
        assert_eq!(
            get(&core, &id, &cronjobs, "tick").await["spec"]["suspend"],
            false
        );
    })
    .await;
}

fn change(key: &str, value: &str) -> Vec<DataChange> {
    vec![DataChange {
        key: key.into(),
        value: Some(value.into()),
    }]
}

#[tokio::test]
#[ignore = "needs make test-kind"]
async fn secret_round_trip() {
    let (core, id, _root) = connected().await;
    let client = core.cluster_client(&id).unwrap();
    with_namespace(&client, async {
        create::<k8s_openapi::api::core::v1::Secret>(
            &client,
            json!({ "metadata": { "name": "s" }, "data": { "a": "b2xk" } }),
        )
        .await;
        let secrets = resource("", "secrets", "Secret");
        let version = get(&core, &id, &secrets, "s").await["metadata"]["resourceVersion"]
            .as_str()
            .unwrap()
            .to_owned();
        core.secret_update(&id, NAMESPACE, "s", &version, change("a", "new text"))
            .await
            .unwrap();
        let value = core.secret_reveal(&id, NAMESPACE, "s", "a").await.unwrap();
        assert_eq!(value.value, "new text");
        assert!(!value.binary);
    })
    .await;
}

#[tokio::test]
#[ignore = "needs make test-kind"]
async fn stale_configmap_update_is_a_conflict() {
    let (core, id, _root) = connected().await;
    let client = core.cluster_client(&id).unwrap();
    with_namespace(&client, async {
        create::<k8s_openapi::api::core::v1::ConfigMap>(
            &client,
            json!({ "metadata": { "name": "c" }, "data": { "a": "1" } }),
        )
        .await;
        let configmaps = resource("", "configmaps", "ConfigMap");
        let stale = get(&core, &id, &configmaps, "c").await["metadata"]["resourceVersion"]
            .as_str()
            .unwrap()
            .to_owned();
        core.configmap_update(&id, NAMESPACE, "c", &stale, change("a", "2"))
            .await
            .unwrap();
        let error = core
            .configmap_update(&id, NAMESPACE, "c", &stale, change("a", "3"))
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::Conflict);
    })
    .await;
}

/// A kubeconfig for the same server and CA that signs in with `token`.
fn kubeconfig_with_token(token: &str) -> String {
    let source: Value =
        serde_yaml_ng::from_str(&std::fs::read_to_string(kind_kubeconfig()).unwrap()).unwrap();
    let cluster = &source["clusters"][0]["cluster"];
    let config = json!({
        "apiVersion": "v1",
        "kind": "Config",
        "clusters": [{ "name": "viewer", "cluster": {
            "server": cluster["server"],
            "certificate-authority-data": cluster["certificate-authority-data"],
        } }],
        "users": [{ "name": "viewer", "user": { "token": token } }],
        "contexts": [{ "name": "viewer", "context": { "cluster": "viewer", "user": "viewer" } }],
        "current-context": "viewer",
    });
    serde_yaml_ng::to_string(&config).unwrap()
}

#[tokio::test]
#[ignore = "needs make test-kind"]
async fn forbidden_scale_shows_the_api_message() {
    let (core, id, _root) = connected().await;
    let client = core.cluster_client(&id).unwrap();
    with_namespace(&client, async {
        create::<k8s_openapi::api::apps::v1::Deployment>(&client, deployment("web", 1)).await;
        let accounts: Api<ServiceAccount> = Api::namespaced(client.clone(), NAMESPACE);
        create::<ServiceAccount>(&client, json!({ "metadata": { "name": "viewer" } })).await;
        create::<k8s_openapi::api::rbac::v1::Role>(
            &client,
            json!({
                "metadata": { "name": "viewer" },
                "rules": [{ "apiGroups": ["apps"], "resources": ["deployments"], "verbs": ["get", "list", "watch"] }],
            }),
        )
        .await;
        create::<k8s_openapi::api::rbac::v1::RoleBinding>(
            &client,
            json!({
                "metadata": { "name": "viewer" },
                "roleRef": { "apiGroup": "rbac.authorization.k8s.io", "kind": "Role", "name": "viewer" },
                "subjects": [{ "kind": "ServiceAccount", "name": "viewer", "namespace": NAMESPACE }],
            }),
        )
        .await;
        let request: TokenRequest = serde_json::from_value(json!({
            "apiVersion": "authentication.k8s.io/v1",
            "kind": "TokenRequest",
            "spec": { "audiences": [] },
        }))
        .unwrap();
        let token = accounts
            .create_token_request("viewer", &PostParams::default(), &request)
            .await
            .unwrap()
            .status
            .unwrap()
            .token;
        let (viewer, viewer_id, _viewer_root) =
            connect_with(&kubeconfig_with_token(token.as_deref().unwrap()), "viewer").await;
        let error = viewer
            .workload_scale(&viewer_id, &deployments(), NAMESPACE, "web", 2)
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::Forbidden);
        assert!(error.message.contains("forbidden"), "{}", error.message);
    })
    .await;
}
