//! What the integration tests share: a core connected to the fake or to the kind cluster.
//! Every kubeconfig lives in a temp `<home>/.kube`; `KUBECONFIG` is never read.
//! Each test binary uses part of this.
#![allow(dead_code)]

use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::path::Path;
use std::time::{Duration, Instant};

use futures::FutureExt;
use k8s_openapi::api::authentication::v1::TokenRequest;
use k8s_openapi::api::core::v1::{Namespace, Pod, ServiceAccount};
use k8s_openapi::api::rbac::v1::{Role, RoleBinding};
use kube::api::{DeleteParams, ObjectMeta, PostParams};
use kube::{Api, Client};
use serde_json::{json, Value};
use skopos_core::app_core::AppCore;
use skopos_core::cluster::ConnectionState;
use skopos_core::kubeconfig::ClusterId;
use skopos_core::paths::AppPaths;
use skopos_fakekube::{FakeKube, FakeKubeConfig};
use tempfile::TempDir;

const FAKE_CONTEXT: &str = "fake";
const KIND_CONTEXT: &str = "kind-skopos-e2e";
const CATALOG_WAIT: Duration = Duration::from_secs(30);
const KIND_WAIT: Duration = Duration::from_secs(120);
/// Small, multi-arch, and has a shell.
pub const TEST_IMAGE: &str = "registry.k8s.io/e2e-test-images/agnhost:2.53";

async fn start_core(root: &Path, context: &str) -> (AppCore, ClusterId) {
    let paths = AppPaths::under(&root.join("app"), &root.join("home"));
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
        assert!(started.elapsed() < CATALOG_WAIT, "no catalog entry");
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    let state = core.cluster_connect(&id).await.unwrap();
    assert!(
        matches!(state, ConnectionState::Connected { .. }),
        "{state:?}"
    );
    (core, id)
}

pub async fn connected_fake(cfg: FakeKubeConfig) -> (AppCore, FakeKube, ClusterId, TempDir) {
    let fake = FakeKube::start(cfg).await.unwrap();
    let root = tempfile::tempdir().unwrap();
    let kube_dir = root.path().join("home").join(".kube");
    std::fs::create_dir_all(&kube_dir).unwrap();
    fake.write_kubeconfig(&kube_dir.join("config"), FAKE_CONTEXT)
        .unwrap();
    let (core, id) = start_core(root.path(), FAKE_CONTEXT).await;
    (core, fake, id, root)
}

/// Needs `make test-kind`. Only `e2e/.tmp/kubeconfig` is read, never a default one.
pub async fn connected_kind() -> (AppCore, ClusterId, TempDir) {
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../e2e/.tmp/kubeconfig");
    let root = tempfile::tempdir().unwrap();
    let kube_dir = root.path().join("home").join(".kube");
    std::fs::create_dir_all(&kube_dir).unwrap();
    std::fs::copy(source, kube_dir.join("config")).unwrap();
    let (core, id) = start_core(root.path(), KIND_CONTEXT).await;
    (core, id, root)
}

/// A core whose only kubeconfig is `kubeconfig`, connected to `context`.
fn from_json<T: serde::de::DeserializeOwned>(value: Value) -> T {
    serde_json::from_value(value).unwrap()
}

/// A kubeconfig for the kind cluster, context `viewer`, that signs in with `token`.
pub fn kubeconfig_with_token(token: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../e2e/.tmp/kubeconfig");
    let source: Value = serde_yaml_ng::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
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

/// A token for a `viewer` service account that may only read ConfigMaps in `namespace`.
pub async fn viewer_token(client: &Client, namespace: &str) -> String {
    let made = PostParams::default();
    let accounts: Api<ServiceAccount> = Api::namespaced(client.clone(), namespace);
    accounts
        .create(
            &made,
            &from_json(json!({ "metadata": { "name": "viewer" } })),
        )
        .await
        .unwrap();
    let roles: Api<Role> = Api::namespaced(client.clone(), namespace);
    let role = json!({
        "metadata": { "name": "viewer" },
        "rules": [{ "apiGroups": [""], "resources": ["configmaps"], "verbs": ["get", "list", "watch"] }],
    });
    roles.create(&made, &from_json(role)).await.unwrap();
    let bindings: Api<RoleBinding> = Api::namespaced(client.clone(), namespace);
    let binding = json!({
        "metadata": { "name": "viewer" },
        "roleRef": { "apiGroup": "rbac.authorization.k8s.io", "kind": "Role", "name": "viewer" },
        "subjects": [{ "kind": "ServiceAccount", "name": "viewer", "namespace": namespace }],
    });
    bindings.create(&made, &from_json(binding)).await.unwrap();
    let request: TokenRequest = from_json(json!({
        "apiVersion": "authentication.k8s.io/v1",
        "kind": "TokenRequest",
        "spec": { "audiences": [] },
    }));
    accounts
        .create_token_request("viewer", &made, &request)
        .await
        .unwrap()
        .status
        .unwrap()
        .token
        .unwrap()
}

pub async fn connected_with(kubeconfig: &str, context: &str) -> (AppCore, ClusterId, TempDir) {
    let root = tempfile::tempdir().unwrap();
    let kube_dir = root.path().join("home").join(".kube");
    std::fs::create_dir_all(&kube_dir).unwrap();
    std::fs::write(kube_dir.join("config"), kubeconfig).unwrap();
    let (core, id) = start_core(root.path(), context).await;
    (core, id, root)
}

/// Waits out a leftover from an earlier failed run, then creates the namespace.
async fn create_namespace(client: &Client, name: &str) {
    let namespaces: Api<Namespace> = Api::all(client.clone());
    let _ = namespaces.delete(name, &DeleteParams::default()).await;
    let started = Instant::now();
    while namespaces.get_opt(name).await.unwrap().is_some() {
        assert!(started.elapsed() < KIND_WAIT, "{name} is still there");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let namespace = Namespace {
        metadata: ObjectMeta {
            name: Some(name.to_owned()),
            ..ObjectMeta::default()
        },
        ..Namespace::default()
    };
    namespaces
        .create(&PostParams::default(), &namespace)
        .await
        .unwrap();
}

/// Runs a test in a new namespace, and deletes the namespace even if the test fails.
pub async fn in_namespace<Fut: Future<Output = ()>>(client: &Client, name: &str, test: Fut) {
    create_namespace(client, name).await;
    let result = AssertUnwindSafe(test).catch_unwind().await;
    let namespaces: Api<Namespace> = Api::all(client.clone());
    let _ = namespaces.delete(name, &DeleteParams::default()).await;
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}

pub async fn create_pod(client: &Client, namespace: &str, pod: Value) -> Pod {
    let pods: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let pod: Pod = serde_json::from_value(pod).unwrap();
    pods.create(&PostParams::default(), &pod).await.unwrap()
}

/// Waits until the pod's phase is `Running`.
pub async fn wait_running(client: &Client, namespace: &str, name: &str) {
    let pods: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let started = Instant::now();
    loop {
        let pod = pods.get(name).await.unwrap();
        let phase = pod.status.and_then(|status| status.phase);
        if phase.as_deref() == Some("Running") {
            return;
        }
        assert!(started.elapsed() < KIND_WAIT, "{name} is {phase:?}");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}
