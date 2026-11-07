//! Node drain against the real `sextant-e2e` kind cluster.
//! Needs `make test-kind`. Only `e2e/.tmp/kubeconfig` is read, never a default one.

use std::panic::AssertUnwindSafe;
use std::path::Path;
use std::time::{Duration, Instant};

use futures::FutureExt;
use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::core::v1::{Namespace, Pod};
use k8s_openapi::api::policy::v1::PodDisruptionBudget;
use kube::api::{DeleteParams, ListParams, ObjectMeta, Patch, PatchParams, PostParams};
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
const HELD: &str = "held";
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

/// A drain evicts every pod on the worker, whichever namespace it is in. Leftovers from
/// other test binaries (a namespace still terminating, say) would make the eviction
/// fail, so this waits for them to go. Finished pods and DaemonSet pods do not block a drain.
async fn wait_for_foreign_pods_to_leave(client: &Client) {
    let pods: Api<Pod> = Api::all(client.clone());
    let params = ListParams::default().fields(&format!("spec.nodeName={WORKER}"));
    let started = Instant::now();
    loop {
        let foreign: Vec<String> = pods
            .list(&params)
            .await
            .unwrap()
            .items
            .into_iter()
            .filter(|pod| pod.metadata.namespace.as_deref() != Some(NAMESPACE))
            .filter(|pod| {
                !pod.metadata
                    .owner_references
                    .iter()
                    .flatten()
                    .any(|owner| owner.kind == "DaemonSet")
            })
            .filter(|pod| {
                !matches!(
                    pod.status.as_ref().and_then(|s| s.phase.as_deref()),
                    Some("Succeeded" | "Failed")
                )
            })
            .map(|pod| {
                format!(
                    "{}/{}",
                    pod.metadata.namespace.unwrap_or_default(),
                    pod.metadata.name.unwrap_or_default()
                )
            })
            .collect();
        if foreign.is_empty() {
            return;
        }
        assert!(
            started.elapsed() < WAIT,
            "pods from other namespaces still on {WORKER}: {foreign:?}"
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
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
        wait_for_foreign_pods_to_leave(&client).await;
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

fn held_pod() -> Pod {
    serde_json::from_value(json!({
        "metadata": { "name": HELD, "labels": { "app": APP } },
        "spec": {
            "nodeName": WORKER,
            "terminationGracePeriodSeconds": 1,
            "containers": [{ "name": "main", "image": "registry.k8s.io/pause:3.10" }],
        },
    }))
    .unwrap()
}

/// A disruption budget refuses the first eviction. While the drain waits to retry,
/// the pod is replaced under the same name, and the budget goes so the retry reaches
/// the API server's precondition check.
#[tokio::test]
#[ignore = "needs make test-kind"]
async fn a_retry_does_not_evict_a_pod_recreated_under_the_same_name() {
    let (core, id, _root) = connected().await;
    let client = core.cluster_client(&id).unwrap();
    create_namespace(&client).await;
    let body = async {
        wait_for_foreign_pods_to_leave(&client).await;
        let pods: Api<Pod> = Api::namespaced(client.clone(), NAMESPACE);
        let budgets: Api<PodDisruptionBudget> = Api::namespaced(client.clone(), NAMESPACE);
        pods.create(&PostParams::default(), &held_pod())
            .await
            .unwrap();
        wait_for_running_pod(&client).await;
        let budget = serde_json::from_value(json!({
            "metadata": { "name": APP },
            "spec": { "minAvailable": 1, "selector": { "matchLabels": { "app": APP } } },
        }))
        .unwrap();
        budgets
            .create(&PostParams::default(), &budget)
            .await
            .unwrap();

        let (tx, mut rx) = mpsc::channel(64);
        let options = DrainOptions {
            force: true,
            delete_empty_dir: true,
            timeout_seconds: Some(DRAIN_SECONDS),
        };
        core.node_drain_start(&id, WORKER, options, tx)
            .await
            .unwrap();
        let mut replacement_uid = None;
        let finished = tokio::time::timeout(WAIT + WAIT, async {
            while let Some(event) = rx.recv().await {
                match event {
                    DrainEvent::PodBlocked { pod, .. }
                        if pod.name == HELD && replacement_uid.is_none() =>
                    {
                        pods.delete(HELD, &DeleteParams::default().grace_period(0))
                            .await
                            .unwrap();
                        let created = pods
                            .create(&PostParams::default(), &held_pod())
                            .await
                            .unwrap();
                        replacement_uid = created.metadata.uid;
                        budgets.delete(APP, &DeleteParams::default()).await.unwrap();
                    }
                    DrainEvent::Finished { outcome, message } => return (outcome, message),
                    _ => {}
                }
            }
            panic!("the drain ended without Finished");
        })
        .await
        .expect("the drain never finished");

        assert_eq!(finished.0, DrainOutcome::Completed, "{:?}", finished.1);
        assert!(replacement_uid.is_some(), "the budget never blocked");
        let current = pods.get(HELD).await.unwrap();
        assert_eq!(current.metadata.uid, replacement_uid);
        assert!(
            current.metadata.deletion_timestamp.is_none(),
            "the replacement was evicted"
        );
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

const HOLD: &str = "sextant.test/hold";

async fn release(pods: &Api<Pod>) {
    let patch = Patch::Merge(json!({ "metadata": { "finalizers": null } }));
    let _ = pods.patch(HELD, &PatchParams::default(), &patch).await;
}

/// The API server refuses to evict a pod whose namespace is terminating. The namespace
/// controller deletes such a pod anyway, so the drain waits for it to go. A finalizer holds
/// the pod, and with it the namespace, until the drain has tried the eviction.
#[tokio::test]
#[ignore = "needs make test-kind"]
async fn a_drain_waits_for_a_pod_whose_namespace_is_terminating() {
    let (core, id, _root) = connected().await;
    let client = core.cluster_client(&id).unwrap();
    create_namespace(&client).await;
    let pods: Api<Pod> = Api::namespaced(client.clone(), NAMESPACE);
    let namespaces: Api<Namespace> = Api::all(client.clone());
    let body = async {
        wait_for_foreign_pods_to_leave(&client).await;
        let mut pod = held_pod();
        pod.metadata.finalizers = Some(vec![HOLD.to_owned()]);
        pods.create(&PostParams::default(), &pod).await.unwrap();
        wait_for_running_pod(&client).await;
        namespaces
            .delete(NAMESPACE, &DeleteParams::default())
            .await
            .unwrap();
        let started = Instant::now();
        while pods
            .get(HELD)
            .await
            .unwrap()
            .metadata
            .deletion_timestamp
            .is_none()
        {
            assert!(
                started.elapsed() < WAIT,
                "the namespace never deleted the pod"
            );
            tokio::time::sleep(Duration::from_millis(200)).await;
        }

        let (tx, mut rx) = mpsc::channel(64);
        let options = DrainOptions {
            force: true,
            delete_empty_dir: true,
            timeout_seconds: Some(DRAIN_SECONDS),
        };
        core.node_drain_start(&id, WORKER, options, tx)
            .await
            .unwrap();
        let mut failures = Vec::new();
        let finished = tokio::time::timeout(WAIT + WAIT, async {
            while let Some(event) = rx.recv().await {
                match event {
                    DrainEvent::PodEvicting { pod } if pod.name == HELD => {
                        // Long enough for the eviction to be answered, refused or not.
                        tokio::time::sleep(Duration::from_secs(3)).await;
                        release(&pods).await;
                    }
                    DrainEvent::PodFailed { pod, message } => failures.push((pod, message)),
                    DrainEvent::Finished { outcome, message } => return (outcome, message),
                    _ => {}
                }
            }
            panic!("the drain ended without Finished");
        })
        .await
        .expect("the drain never finished");

        assert!(failures.is_empty(), "{failures:?}");
        assert_eq!(finished.0, DrainOutcome::Completed, "{:?}", finished.1);
    };
    let outcome = AssertUnwindSafe(body).catch_unwind().await;
    release(&pods).await;
    let uncordoned = core.node_set_unschedulable(&id, WORKER, false).await;
    let _ = namespaces.delete(NAMESPACE, &DeleteParams::default()).await;
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
    uncordoned.unwrap();
}
