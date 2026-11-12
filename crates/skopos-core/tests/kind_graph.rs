//! The resource graph against the real `skopos-e2e` kind cluster (spec E §4.8).
//! Needs `make test-kind`. Only `e2e/.tmp/kubeconfig` is read, never a default one.

use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{Duration, Instant};

use futures::FutureExt;
use k8s_openapi::api::core::v1::{ConfigMap, Namespace};
use kube::api::{
    ApiResource, DeleteParams, DynamicObject, ObjectMeta, Patch, PatchParams, PostParams,
};
use kube::{Api, Client};
use serde_json::{json, Value};
use skopos_core::app_core::AppCore;
use skopos_core::cluster::ConnectionState;
use skopos_core::graph::{
    GraphEdge, GraphEvent, GraphNamespaceCount, GraphNode, GraphRel, GraphStatus,
};
use skopos_core::kubeconfig::ClusterId;
use skopos_core::paths::AppPaths;
use tempfile::TempDir;
use tokio::sync::mpsc;

const CONTEXT: &str = "kind-skopos-e2e";
/// The namespace, and the GatewayClass's name.
const NAMESPACE: &str = "skopos-test-graph";
const GATEWAY: &str = "gateway.networking.k8s.io";
const GATEWAY_API: &str =
    "https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.7.0/standard-install.yaml";
const GATEWAY_CRDS: [&str; 3] = [
    "crd/gatewayclasses.gateway.networking.k8s.io",
    "crd/gateways.gateway.networking.k8s.io",
    "crd/httproutes.gateway.networking.k8s.io",
];
const WAIT: Duration = Duration::from_secs(120);
const SECRET_VALUE: &str = "graph-test-secret-value";
/// `SECRET_VALUE` in base64, as the API server keeps it.
const SECRET_BASE64: &str = "Z3JhcGgtdGVzdC1zZWNyZXQtdmFsdWU=";
const PLAIN_VALUE: &str = "graph-test-plain-value";

fn kubeconfig() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../e2e/.tmp/kubeconfig")
}

fn kubectl(args: &[&str]) -> Output {
    Command::new("kubectl")
        .arg("--kubeconfig")
        .arg(kubeconfig())
        .args(["--context", CONTEXT])
        .args(args)
        .output()
        .expect("kubectl runs")
}

/// Spec E §18.3: the interface's e2e fixture runs the same command. Both leave the CRDs.
fn install_gateway_api() {
    let applied = kubectl(&[
        "--request-timeout=60s",
        "apply",
        "--server-side",
        "--force-conflicts",
        "--field-manager=skopos-e2e",
        "-f",
        GATEWAY_API,
    ]);
    assert!(
        applied.status.success(),
        "{}",
        String::from_utf8_lossy(&applied.stderr)
    );
    // A CRD just created has no conditions yet, and kubectl wait then fails at once instead of
    // waiting, so try again.
    let started = Instant::now();
    loop {
        let mut args = vec!["wait", "--for=condition=Established", "--timeout=60s"];
        args.extend(GATEWAY_CRDS);
        let waited = kubectl(&args);
        if waited.status.success() {
            break;
        }
        assert!(
            started.elapsed() < Duration::from_secs(90),
            "{}",
            String::from_utf8_lossy(&waited.stderr)
        );
        std::thread::sleep(Duration::from_secs(2));
    }
}

/// Connects after the CRDs are in, since discovery is read when the cluster connects.
async fn connected() -> (AppCore, ClusterId, TempDir) {
    let root = tempfile::tempdir().unwrap();
    let kube_dir = root.path().join("home").join(".kube");
    std::fs::create_dir_all(&kube_dir).unwrap();
    std::fs::copy(kubeconfig(), kube_dir.join("config")).unwrap();
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

fn api(
    client: &Client,
    group: &str,
    kind: &str,
    plural: &str,
    namespaced: bool,
) -> Api<DynamicObject> {
    let api_version = if group.is_empty() {
        "v1".to_owned()
    } else {
        format!("{group}/v1")
    };
    let resource = ApiResource {
        group: group.into(),
        version: "v1".into(),
        api_version,
        kind: kind.into(),
        plural: plural.into(),
    };
    if namespaced {
        Api::namespaced_with(client.clone(), NAMESPACE, &resource)
    } else {
        Api::all_with(client.clone(), &resource)
    }
}

fn gateway_classes(client: &Client) -> Api<DynamicObject> {
    api(client, GATEWAY, "GatewayClass", "gatewayclasses", false)
}

async fn apply(api: &Api<DynamicObject>, object: Value) {
    let name = object["metadata"]["name"].as_str().unwrap().to_owned();
    let params = PatchParams::apply("skopos-test").force();
    api.patch(&name, &params, &Patch::Apply(&object))
        .await
        .unwrap_or_else(|e| panic!("apply {name}: {e}"));
}

/// The objects of the interface's e2e fixture (spec E §18.3), in this test's namespace.
async fn create_fixture(client: &Client) {
    let meta = |name: &str| json!({ "name": name, "namespace": NAMESPACE });
    apply(
        &gateway_classes(client),
        json!({
            "apiVersion": format!("{GATEWAY}/v1"),
            "kind": "GatewayClass",
            "metadata": { "name": NAMESPACE },
            "spec": { "controllerName": "example.com/skopos-test" },
        }),
    )
    .await;
    let objects = [
        (
            GATEWAY,
            "Gateway",
            "gateways",
            json!({
                "metadata": meta("edge"),
                "spec": {
                    "gatewayClassName": NAMESPACE,
                    "listeners": [{ "name": "http", "port": 80, "protocol": "HTTP" }],
                },
            }),
        ),
        (
            GATEWAY,
            "HTTPRoute",
            "httproutes",
            json!({
                "metadata": meta("web"),
                "spec": {
                    "parentRefs": [{ "name": "edge" }],
                    "rules": [{ "backendRefs": [{ "name": "web", "port": 80 }] }],
                },
            }),
        ),
        (
            "networking.k8s.io",
            "Ingress",
            "ingresses",
            json!({
                "metadata": meta("web"),
                "spec": { "defaultBackend": { "service": { "name": "web", "port": { "number": 80 } } } },
            }),
        ),
        (
            "",
            "Service",
            "services",
            json!({
                "metadata": meta("web"),
                "spec": { "selector": { "app": "web" }, "ports": [{ "port": 80 }] },
            }),
        ),
        (
            "",
            "ServiceAccount",
            "serviceaccounts",
            json!({ "metadata": meta("web") }),
        ),
        (
            "",
            "ConfigMap",
            "configmaps",
            json!({ "metadata": meta("web-config"), "data": { "mode": "fast" } }),
        ),
        (
            "",
            "Secret",
            "secrets",
            json!({
                "metadata": meta("web-secret"),
                "type": "Opaque",
                "stringData": { "TOKEN": SECRET_VALUE },
            }),
        ),
        (
            "",
            "PersistentVolumeClaim",
            "persistentvolumeclaims",
            json!({
                "metadata": meta("web-data"),
                "spec": { "accessModes": ["ReadWriteOnce"], "resources": { "requests": { "storage": "1Mi" } } },
            }),
        ),
        (
            "apps",
            "Deployment",
            "deployments",
            json!({
                "metadata": meta("web"),
                "spec": {
                    "replicas": 1,
                    "selector": { "matchLabels": { "app": "web" } },
                    "template": {
                        "metadata": { "labels": { "app": "web" } },
                        "spec": {
                            "serviceAccountName": "web",
                            "containers": [{
                                "name": "app",
                                "image": "registry.k8s.io/pause:3.10",
                                "env": [{ "name": "PLAIN", "value": PLAIN_VALUE }],
                                "envFrom": [{ "secretRef": { "name": "web-secret" } }],
                                "volumeMounts": [
                                    { "name": "config", "mountPath": "/config" },
                                    { "name": "data", "mountPath": "/data" },
                                ],
                            }],
                            "volumes": [
                                { "name": "config", "configMap": { "name": "web-config" } },
                                { "name": "data", "persistentVolumeClaim": { "claimName": "web-data" } },
                            ],
                        },
                    },
                },
            }),
        ),
    ];
    for (group, kind, plural, mut object) in objects {
        object["apiVersion"] = json!(if group.is_empty() {
            "v1".to_owned()
        } else {
            format!("{group}/v1")
        });
        object["kind"] = json!(kind);
        apply(&api(client, group, kind, plural, true), object).await;
    }
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

/// Builds the fixture, runs `body`, removes the namespace and the GatewayClass whether or not
/// it failed, then reports the failure.
async fn with_fixture<F>(client: &Client, body: F)
where
    F: std::future::Future<Output = ()>,
{
    create_namespace(client).await;
    let outcome = AssertUnwindSafe(async {
        create_fixture(client).await;
        body.await;
    })
    .catch_unwind()
    .await;
    let namespaces: Api<Namespace> = Api::all(client.clone());
    let _ = namespaces.delete(NAMESPACE, &DeleteParams::default()).await;
    let _ = gateway_classes(client)
        .delete(NAMESPACE, &DeleteParams::default())
        .await;
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}

fn id(kind: &str, name: &str) -> String {
    format!("{kind}/{NAMESPACE}/{name}")
}

struct Snapshot {
    nodes: Vec<GraphNode>,
    edges: Vec<GraphEdge>,
    counts: Vec<GraphNamespaceCount>,
    missing: Vec<String>,
    gateway_api: bool,
    json: String,
}

impl Snapshot {
    fn find(&self, id: &str) -> Option<&GraphNode> {
        self.nodes.iter().find(|n| n.id == id)
    }

    fn node(&self, id: &str) -> &GraphNode {
        self.find(id).unwrap_or_else(|| {
            let ids: Vec<&str> = self.nodes.iter().map(|n| n.id.as_str()).collect();
            panic!("no {id} in {ids:?}")
        })
    }

    /// The one node of `kind` in the namespace, whose name the cluster chose.
    fn only(&self, kind: &str) -> &GraphNode {
        let prefix = format!("{kind}/{NAMESPACE}/");
        let found: Vec<&GraphNode> = self
            .nodes
            .iter()
            .filter(|n| n.id.starts_with(&prefix))
            .collect();
        assert_eq!(found.len(), 1, "{kind}: {found:?}");
        found[0]
    }

    fn has_edge(&self, from: &str, to: &str, rel: GraphRel) -> bool {
        self.edges
            .iter()
            .any(|e| e.from == from && e.to == to && e.rel == rel)
    }
}

struct Map {
    id: String,
    rx: mpsc::Receiver<GraphEvent>,
}

impl Map {
    fn start(core: &AppCore, cluster: &ClusterId) -> Self {
        let (tx, rx) = mpsc::channel(16);
        let id = core
            .resource_graph_subscribe(cluster, Some(vec![NAMESPACE.to_owned()]), tx)
            .unwrap();
        Self { id, rx }
    }

    /// Reads snapshots until one satisfies `done`. Review Focus 2: no snapshot on the way
    /// holds a Secret's value or an environment variable's value.
    async fn until(&mut self, what: &str, done: impl Fn(&Snapshot) -> bool) -> Snapshot {
        let started = Instant::now();
        loop {
            let left = WAIT
                .checked_sub(started.elapsed())
                .unwrap_or_else(|| panic!("timed out waiting for {what}"));
            let event = tokio::time::timeout(left, self.rx.recv())
                .await
                .unwrap_or_else(|_| panic!("timed out waiting for {what}"))
                .expect("the subscription ended");
            let json = serde_json::to_string(&event).unwrap();
            for value in [SECRET_VALUE, SECRET_BASE64, PLAIN_VALUE] {
                assert!(!json.contains(value), "{value} left the core");
            }
            let GraphEvent::Snapshot {
                nodes,
                edges,
                counts,
                missing,
                gateway_api,
            } = event
            else {
                panic!("expected a snapshot, got {json}");
            };
            let snapshot = Snapshot {
                nodes,
                edges,
                counts,
                missing,
                gateway_api,
                json,
            };
            if done(&snapshot) {
                return snapshot;
            }
        }
    }
}

fn status_of<'a>(snapshot: &'a Snapshot, id: &str) -> (GraphStatus, Option<&'a str>) {
    let node = snapshot.node(id);
    (node.status, node.status_text.as_deref())
}

#[tokio::test]
#[ignore = "needs the skopos-e2e kind cluster"]
async fn the_graph_of_the_e2e_fixture() {
    install_gateway_api();
    let (core, cluster, _root) = connected().await;
    let client = core.cluster_client(&cluster).unwrap();
    with_fixture(&client, async {
        let mut map = Map::start(&core, &cluster);
        let ready = map
            .until("the Deployment and the Service to be ready", |s| {
                let nominal = |node: &str| {
                    s.find(node)
                        .is_some_and(|n| n.status == GraphStatus::Nominal)
                };
                nominal(&id("Deployment", "web")) && nominal(&id("Service", "web"))
            })
            .await;

        let replica_set = ready.only("ReplicaSet").id.clone();
        let pod = ready.only("Pod").id.clone();
        let class = format!("GatewayClass//{NAMESPACE}");
        let expected = [
            (id("Deployment", "web"), replica_set.clone(), GraphRel::Owns),
            (replica_set.clone(), pod.clone(), GraphRel::Owns),
            (id("Service", "web"), pod.clone(), GraphRel::Selects),
            (id("Ingress", "web"), id("Service", "web"), GraphRel::Routes),
            (
                id("Gateway", "edge"),
                id("HTTPRoute", "web"),
                GraphRel::Routes,
            ),
            (
                id("HTTPRoute", "web"),
                id("Service", "web"),
                GraphRel::Routes,
            ),
            (id("Gateway", "edge"), class.clone(), GraphRel::Class),
            (pod.clone(), id("ConfigMap", "web-config"), GraphRel::Mounts),
            (
                pod.clone(),
                id("PersistentVolumeClaim", "web-data"),
                GraphRel::Claims,
            ),
            (pod.clone(), id("Secret", "web-secret"), GraphRel::Env),
            (pod.clone(), id("ServiceAccount", "web"), GraphRel::RunsAs),
        ];
        for (from, to, rel) in &expected {
            assert!(ready.has_edge(from, to, *rel), "{from} {rel:?} {to}");
        }
        assert_eq!(ready.edges.len(), expected.len(), "{:?}", ready.edges);
        assert_eq!(
            ready.nodes.len(),
            12,
            "eleven in the namespace and the GatewayClass"
        );
        let counted = ready
            .counts
            .iter()
            .find(|c| c.namespace == NAMESPACE)
            .map(|c| c.nodes);
        assert_eq!(counted, Some(11));
        assert!(ready.missing.is_empty(), "{:?}", ready.missing);
        assert!(ready.gateway_api);
        assert!(
            !ready.json.contains("kube-root-ca.crt"),
            "the projected root CA gives no node"
        );

        // Nothing runs a Gateway or Ingress controller on the kind cluster.
        assert_eq!(
            status_of(&ready, &class),
            (GraphStatus::Warning, Some("Waiting for the controller"))
        );
        assert_eq!(
            status_of(&ready, &id("Gateway", "edge")),
            (GraphStatus::Warning, Some("Not programmed yet"))
        );
        assert_eq!(
            status_of(&ready, &id("HTTPRoute", "web")),
            (GraphStatus::Warning, Some("Not accepted yet"))
        );
        assert_eq!(
            status_of(&ready, &id("Ingress", "web")),
            (GraphStatus::Warning, Some("No address yet"))
        );
        assert_eq!(
            status_of(&ready, &pod),
            (GraphStatus::Nominal, Some("Running"))
        );
        assert_eq!(
            ready.node(&id("Secret", "web-secret")).facts,
            [
                ("Type".to_owned(), "Opaque".to_owned()),
                ("Keys".to_owned(), "1".to_owned()),
            ]
        );

        let config_maps: Api<ConfigMap> = Api::namespaced(client.clone(), NAMESPACE);
        config_maps
            .delete("web-config", &DeleteParams::default())
            .await
            .unwrap();
        let later = map
            .until("the ConfigMap to be gone", |s| {
                s.find(&id("ConfigMap", "web-config"))
                    .is_some_and(|n| n.status_text.as_deref() == Some("Not found"))
            })
            .await;
        assert_eq!(
            status_of(&later, &id("ConfigMap", "web-config")).0,
            GraphStatus::Critical
        );
        core.resource_graph_unsubscribe(&map.id);
    })
    .await;
}
