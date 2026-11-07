//! Object operations against the real `skopos-e2e` kind cluster.
//! Needs `make test-kind`. Only `e2e/.tmp/kubeconfig` is read, never a default one.

use std::panic::AssertUnwindSafe;
use std::path::Path;
use std::time::{Duration, Instant};

use futures::FutureExt;
use k8s_openapi::api::apps::v1::{Deployment, ReplicaSet};
use k8s_openapi::api::core::v1::{ConfigMap, Namespace, Pod};
use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
use kube::api::{DeleteParams, ListParams, ObjectMeta, Patch, PatchParams, PostParams};
use kube::{Api, Client};
use serde_json::json;
use skopos_core::app_core::AppCore;
use skopos_core::cluster::ConnectionState;
use skopos_core::error::ErrorCode;
use skopos_core::kubeconfig::ClusterId;
use skopos_core::paths::AppPaths;
use skopos_core::resources::{Propagation, ResourceRef};
use tempfile::TempDir;

const CONTEXT: &str = "kind-skopos-e2e";
const NAMESPACE: &str = "skopos-test-ops";
const CRD_NAME: &str = "widgets.skopos-test.example.com";
const WAIT: Duration = Duration::from_secs(60);

async fn connected() -> (AppCore, ClusterId, TempDir) {
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../e2e/.tmp/kubeconfig");
    let root = tempfile::tempdir().unwrap();
    let kube_dir = root.path().join("home").join(".kube");
    std::fs::create_dir_all(&kube_dir).unwrap();
    std::fs::copy(source, kube_dir.join("config")).unwrap();
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

/// Waits out a leftover from an earlier failed run, then creates the namespace.
async fn create_namespace(client: &Client) {
    let namespaces: Api<Namespace> = Api::all(client.clone());
    let _ = namespaces.delete(NAMESPACE, &DeleteParams::default()).await;
    let started = Instant::now();
    while namespaces.get_opt(NAMESPACE).await.unwrap().is_some() {
        assert!(started.elapsed() < Duration::from_secs(90), "still there");
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
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

fn configmaps() -> ResourceRef {
    ResourceRef {
        group: String::new(),
        version: "v1".into(),
        plural: "configmaps".into(),
        kind: "ConfigMap".into(),
        namespaced: true,
    }
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

/// Reads the cluster's own pods and changes nothing, so it needs no namespace of its own.
#[tokio::test]
#[ignore = "needs make test-kind"]
async fn listing_once_honours_namespace_and_selectors() {
    let (core, id, _root) = connected().await;
    let core_resource = |kind: &str, plural: &str, namespaced: bool| ResourceRef {
        group: String::new(),
        version: "v1".into(),
        plural: plural.into(),
        kind: kind.into(),
        namespaced,
    };
    let pods = core_resource("Pod", "pods", true);

    let nodes = core
        .resources_list(
            &id,
            &core_resource("Node", "nodes", false),
            None,
            None,
            None,
        )
        .await
        .unwrap();
    assert_eq!(nodes[0]["kind"], "Node");
    let node = nodes[0]["metadata"]["name"].as_str().unwrap();

    let on_node = core
        .resources_list(
            &id,
            &pods,
            None,
            None,
            Some(&format!("spec.nodeName={node}")),
        )
        .await
        .unwrap();
    assert!(!on_node.is_empty());
    assert!(on_node.iter().all(|pod| pod["spec"]["nodeName"] == node));
    assert!(on_node.iter().all(|pod| pod["kind"] == "Pod"));

    let control_plane = core
        .resources_list(
            &id,
            &pods,
            Some("kube-system"),
            Some("tier=control-plane"),
            None,
        )
        .await
        .unwrap();
    assert!(!control_plane.is_empty());
    assert!(control_plane.iter().all(|pod| {
        pod["metadata"]["namespace"] == "kube-system"
            && pod["metadata"]["labels"]["tier"] == "control-plane"
    }));

    // Refused, and not answered with every pod.
    core.resources_list(&id, &pods, None, Some("not a selector!"), None)
        .await
        .unwrap_err();
}

#[tokio::test]
#[ignore = "needs make test-kind"]
async fn real_edit_conflict_flow() {
    let (core, id, _root) = connected().await;
    let client = core.cluster_client(&id).unwrap();
    let body = async {
        let maps: Api<ConfigMap> = Api::namespaced(client.clone(), NAMESPACE);
        let map: ConfigMap = serde_json::from_value(json!({
            "metadata": { "name": "edited" },
            "data": { "key": "first" },
        }))
        .unwrap();
        maps.create(&PostParams::default(), &map).await.unwrap();

        let yaml = core
            .resource_get_yaml(&id, &configmaps(), Some(NAMESPACE), "edited")
            .await
            .unwrap();
        assert!(!yaml.contains("managedFields"), "{yaml}");

        maps.patch(
            "edited",
            &PatchParams::default(),
            &Patch::Merge(json!({ "data": { "key": "second" } })),
        )
        .await
        .unwrap();

        let edited = yaml.replace("first", "mine");
        let err = core
            .resource_replace(
                &id,
                &configmaps(),
                Some(NAMESPACE),
                "edited",
                &edited,
                false,
            )
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Conflict, "{}", err.message);

        let stored = core
            .resource_replace(&id, &configmaps(), Some(NAMESPACE), "edited", &edited, true)
            .await
            .unwrap();
        assert_eq!(stored["data"]["key"], "mine");
        let current = maps.get("edited").await.unwrap();
        assert_eq!(
            current.data.unwrap().get("key").map(String::as_str),
            Some("mine")
        );
    };
    with_namespace(&client, body).await;
}

#[tokio::test]
#[ignore = "needs make test-kind"]
async fn apply_crd_then_instance_in_one_request() {
    let (core, id, _root) = connected().await;
    let client = core.cluster_client(&id).unwrap();
    let crds: Api<CustomResourceDefinition> = Api::all(client.clone());
    let remove_crd = || async {
        let _ = crds.delete(CRD_NAME, &DeleteParams::default()).await;
        eventually("the CRD to go", || async {
            crds.get_opt(CRD_NAME).await.unwrap().is_none()
        })
        .await;
    };
    remove_crd().await;
    let yaml = format!(
        "# a type, then an object of it\n\
         apiVersion: apiextensions.k8s.io/v1\n\
         kind: CustomResourceDefinition\n\
         metadata:\n  name: {CRD_NAME}\n\
         spec:\n\
         \x20 group: skopos-test.example.com\n\
         \x20 scope: Namespaced\n\
         \x20 names:\n\
         \x20   plural: widgets\n\
         \x20   singular: widget\n\
         \x20   kind: Widget\n\
         \x20 versions:\n\
         \x20   - name: v1\n\
         \x20     served: true\n\
         \x20     storage: true\n\
         \x20     schema:\n\
         \x20       openAPIV3Schema:\n\
         \x20         type: object\n\
         \x20         x-kubernetes-preserve-unknown-fields: true\n\
         ---\n\
         ---\n\
         apiVersion: skopos-test.example.com/v1\n\
         kind: Widget\n\
         metadata:\n  name: first\n\
         spec:\n  size: 3\n"
    );
    let widgets = ResourceRef {
        group: "skopos-test.example.com".into(),
        version: "v1".into(),
        plural: "widgets".into(),
        kind: "Widget".into(),
        namespaced: true,
    };
    let body = async {
        let results = core.resource_apply(&id, &yaml, NAMESPACE).await.unwrap();
        assert_eq!(results.len(), 2, "{results:?}");
        assert!(results[0].ok, "{:?}", results[0]);
        assert_eq!(results[0].namespace, None);
        assert!(results[1].ok, "{:?}", results[1]);
        assert_eq!(results[1].namespace.as_deref(), Some(NAMESPACE));

        let widget = core
            .resource_get(&id, &widgets, Some(NAMESPACE), "first")
            .await
            .unwrap();
        assert_eq!(widget["spec"]["size"], 3);
        let managers = client
            .request::<serde_json::Value>(
                http::Request::get(format!(
                    "/apis/skopos-test.example.com/v1/namespaces/{NAMESPACE}/widgets/first"
                ))
                .body(Vec::new())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            managers["metadata"]["managedFields"][0]["manager"],
            "skopos"
        );
        assert_eq!(
            managers["metadata"]["managedFields"][0]["operation"],
            "Apply"
        );
    };
    let outcome = AssertUnwindSafe(with_namespace(&client, body))
        .catch_unwind()
        .await;
    remove_crd().await;
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}

#[tokio::test]
#[ignore = "needs make test-kind"]
async fn delete_with_foreground_propagation_removes_pods() {
    let (core, id, _root) = connected().await;
    let client = core.cluster_client(&id).unwrap();
    let yaml = "apiVersion: apps/v1\n\
                kind: Deployment\n\
                metadata:\n  name: doomed\n\
                spec:\n\
                \x20 replicas: 1\n\
                \x20 selector:\n\
                \x20   matchLabels:\n\
                \x20     app: doomed\n\
                \x20 template:\n\
                \x20   metadata:\n\
                \x20     labels:\n\
                \x20       app: doomed\n\
                \x20   spec:\n\
                \x20     containers:\n\
                \x20       - name: main\n\
                \x20         image: registry.k8s.io/pause:3.10\n";
    let body = async {
        let results = core.resource_apply(&id, yaml, NAMESPACE).await.unwrap();
        assert!(results[0].ok, "{:?}", results[0]);

        let selected = ListParams::default().labels("app=doomed");
        let sets: Api<ReplicaSet> = Api::namespaced(client.clone(), NAMESPACE);
        let pods: Api<Pod> = Api::namespaced(client.clone(), NAMESPACE);
        let deployments_api: Api<Deployment> = Api::namespaced(client.clone(), NAMESPACE);
        eventually("the pod", || async {
            !pods.list(&selected).await.unwrap().items.is_empty()
        })
        .await;
        assert!(!sets.list(&selected).await.unwrap().items.is_empty());

        core.resource_delete(
            &id,
            &deployments(),
            Some(NAMESPACE),
            "doomed",
            Propagation::Foreground,
        )
        .await
        .unwrap();

        eventually("the deployment to go", || async {
            deployments_api.get_opt("doomed").await.unwrap().is_none()
        })
        .await;
        // Foreground deletion removes the dependents before the owner.
        assert!(sets.list(&selected).await.unwrap().items.is_empty());
        eventually("the pod to go", || async {
            pods.list(&selected).await.unwrap().items.is_empty()
        })
        .await;
    };
    with_namespace(&client, body).await;
}
