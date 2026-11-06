//! Node drain against the real `sextant-e2e` kind cluster.
//! Needs `make test-kind`. Only `e2e/.tmp/kubeconfig` is read, never a default one.

use std::panic::AssertUnwindSafe;
use std::path::Path;
use std::time::{Duration, Instant};

use futures::FutureExt;
use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::core::v1::{Namespace, Pod};
use kube::api::{DeleteParams, ListParams, ObjectMeta, PostParams};
use kube::{Api, Client};
use serde_json::json;
use sextant_core::app_core::AppCore;
use sextant_core::cluster::ConnectionState;
use sextant_core::kubeconfig::ClusterId;
use sextant_core::paths::AppPaths;
use sextant_core::resources::{DrainEvent, DrainOptions, DrainOutcome, SkipReason};
use tempfile::TempDir;
use tokio::sync::mpsc;

const CONTEXT: &str = "kind-sextant-e2e";
const NAMESPACE: &str = "sextant-test-drain";
const WORKER: &str = "sextant-e2e-worker";
const APP: &str = "drained";
const WAIT: Duration = Duration::from_secs(120);
const DRAIN_SECONDS: u32 = 150;

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

async fn pods_on_worker(client: &Client) -> Vec<Pod> {
    let pods: Api<Pod> = Api::namespaced(client.clone(), NAMESPACE);
    let params = ListParams::default()
        .labels(&format!("app={APP}"))
        .fields(&format!("spec.nodeName={WORKER}"));
    pods.list(&params).await.unwrap().items
}

async fn create_deployment(client: &Client) {
    let deployments: Api<Deployment> = Api::namespaced(client.clone(), NAMESPACE);
    let deployment = serde_json::from_value(json!({
        "metadata": { "name": APP },
        "spec": {
            "replicas": 1,
            "selector": { "matchLabels": { "app": APP } },
            "template": {
                "metadata": { "labels": { "app": APP } },
                "spec": {
                    "nodeSelector": { "kubernetes.io/hostname": WORKER },
                    "terminationGracePeriodSeconds": 1,
                    "containers": [{ "name": "main", "image": "registry.k8s.io/pause:3.10" }],
                },
            },
        },
    }))
    .unwrap();
    deployments
        .create(&PostParams::default(), &deployment)
        .await
        .unwrap();
}

async fn wait_for_running_pod(client: &Client) {
    let started = Instant::now();
    loop {
        let running = pods_on_worker(client)
            .await
            .iter()
            .any(|pod| pod.status.as_ref().and_then(|s| s.phase.as_deref()) == Some("Running"));
        if running {
            return;
        }
        assert!(started.elapsed() < WAIT, "the pod never ran on {WORKER}");
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

async fn drain_worker(core: &AppCore, id: &ClusterId) -> Vec<DrainEvent> {
    let (tx, mut rx) = mpsc::channel(64);
    let options = DrainOptions {
        force: false,
        delete_empty_dir: true,
        timeout_seconds: Some(DRAIN_SECONDS),
    };
    core.node_drain_start(id, WORKER, options, tx)
        .await
        .unwrap();
    let mut events = Vec::new();
    let limit = Duration::from_secs(u64::from(DRAIN_SECONDS)) + WAIT;
    tokio::time::timeout(limit, async {
        while let Some(event) = rx.recv().await {
            let done = matches!(event, DrainEvent::Finished { .. });
            events.push(event);
            if done {
                return;
            }
        }
    })
    .await
    .expect("the drain never finished");
    events
}

#[tokio::test]
#[ignore = "needs make test-kind"]
async fn drain_empties_the_worker_and_skips_daemonsets() {
    let (core, id, _root) = connected().await;
    let client = core.cluster_client(&id).unwrap();
    create_namespace(&client).await;
    let body = async {
        create_deployment(&client).await;
        wait_for_running_pod(&client).await;

        let events = drain_worker(&core, &id).await;

        match events.last() {
            Some(DrainEvent::Finished { outcome, message }) => {
                assert_eq!(*outcome, DrainOutcome::Completed, "{message:?}");
            }
            other => panic!("no Finished event: {other:?}"),
        }
        let skipped = events
            .iter()
            .find_map(|event| match event {
                DrainEvent::Planned { skipped, .. } => Some(skipped),
                _ => None,
            })
            .expect("no Planned event");
        assert!(
            skipped.iter().any(|pod| {
                matches!(pod.reason, SkipReason::DaemonSet)
                    && (pod.pod.name.starts_with("kindnet")
                        || pod.pod.name.starts_with("kube-proxy"))
            }),
            "{skipped:?}"
        );
        assert!(pods_on_worker(&client).await.is_empty());
    };
    let outcome = AssertUnwindSafe(body).catch_unwind().await;
    let uncordoned = core.node_set_unschedulable(&id, WORKER, false).await;
    let namespaces: Api<Namespace> = Api::all(client.clone());
    let _ = namespaces.delete(NAMESPACE, &DeleteParams::default()).await;
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
    uncordoned.unwrap();
}
