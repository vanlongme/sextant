//! Port-forwards carrying real data on the `sextant-e2e` kind cluster.
//! Needs `make test-kind`. Only `e2e/.tmp/kubeconfig` is read, never a default one.

mod support;

use std::time::{Duration, Instant};

use k8s_openapi::api::core::v1::{Pod, Service};
use kube::api::{DeleteParams, PostParams};
use kube::{Api, Client};
use serde_json::{json, Value};
use sextant_core::app_core::AppCore;
use sextant_core::kubeconfig::ClusterId;
use sextant_core::portforward::{
    PortForwardKind, PortForwardPort, PortForwardSpec, PortForwardState, PortForwardTarget,
};
use support::{connected_kind, create_pod, in_namespace, wait_running, TEST_IMAGE};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

const WAIT: Duration = Duration::from_secs(120);

fn web_pod(name: &str, app: &str) -> Value {
    json!({
        "metadata": { "name": name, "labels": { "app": app } },
        "spec": {
            "terminationGracePeriodSeconds": 0,
            "containers": [{
                "name": "web",
                "image": TEST_IMAGE,
                "args": ["netexec", "--http-port=8080"],
                "ports": [{ "name": "http", "containerPort": 8080 }],
                "readinessProbe": { "httpGet": { "path": "/", "port": 8080 }, "periodSeconds": 1 },
            }],
        },
    })
}

/// Waits until the pod's Ready condition is true.
async fn wait_ready(client: &Client, namespace: &str, name: &str) {
    let pods: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let started = Instant::now();
    loop {
        let pod = serde_json::to_value(pods.get(name).await.unwrap()).unwrap();
        let ready = pod
            .pointer("/status/conditions")
            .and_then(Value::as_array)
            .is_some_and(|conditions| {
                conditions
                    .iter()
                    .any(|c| c["type"] == "Ready" && c["status"] == "True")
            });
        if ready {
            return;
        }
        assert!(started.elapsed() < WAIT, "{name} never became ready");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

fn request_text(path: &str, connection: &str) -> String {
    format!("GET {path} HTTP/1.1\r\nHost: test\r\nConnection: {connection}\r\n\r\n")
}

/// One HTTP request over its own connection. Returns the response body.
async fn get(port: u16, path: &str) -> String {
    let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    socket
        .write_all(request_text(path, "close").as_bytes())
        .await
        .unwrap();
    let mut response = String::new();
    socket.read_to_string(&mut response).await.unwrap();
    let (_, body) = response
        .split_once("\r\n\r\n")
        .unwrap_or_else(|| panic!("not a response: {response:?}"));
    body.to_owned()
}

/// One HTTP request on a connection that stays open.
async fn get_keep_alive(socket: &mut TcpStream, path: &str) -> String {
    socket
        .write_all(request_text(path, "keep-alive").as_bytes())
        .await
        .unwrap();
    let mut buffer = vec![0; 4096];
    let count = tokio::time::timeout(WAIT, socket.read(&mut buffer))
        .await
        .unwrap()
        .unwrap();
    String::from_utf8_lossy(&buffer[..count]).into_owned()
}

fn spec(
    id: &ClusterId,
    kind: PortForwardKind,
    namespace: &str,
    name: &str,
    target_port: PortForwardPort,
) -> PortForwardSpec {
    PortForwardSpec {
        cluster_id: id.clone(),
        target: PortForwardTarget {
            kind,
            namespace: namespace.to_owned(),
            name: name.to_owned(),
        },
        target_port,
        local_port: None,
    }
}

async fn start(core: &AppCore, spec: PortForwardSpec) -> (String, u16) {
    let added = core.portforward_add(spec).unwrap();
    let running = core.portforward_start(&added.id).await.unwrap();
    assert_eq!(running.state, PortForwardState::Running);
    (added.id, running.bound_port.unwrap())
}

async fn kind_client() -> (AppCore, ClusterId, Client, tempfile::TempDir) {
    let (core, id, root) = connected_kind().await;
    let client = core.cluster_client(&id).unwrap();
    (core, id, client, root)
}

#[tokio::test]
#[ignore = "needs the sextant-e2e kind cluster"]
async fn a_pod_is_reached_by_number_and_by_port_name() {
    const NAMESPACE: &str = "sextant-test-forward-pod";
    let (core, id, client, _root) = kind_client().await;
    in_namespace(&client, NAMESPACE, async {
        create_pod(&client, NAMESPACE, web_pod("direct", "direct")).await;
        wait_ready(&client, NAMESPACE, "direct").await;
        let (_, by_number) = start(
            &core,
            spec(
                &id,
                PortForwardKind::Pod,
                NAMESPACE,
                "direct",
                PortForwardPort::Number(8080),
            ),
        )
        .await;
        assert_eq!(get(by_number, "/hostname").await, "direct");
        let (_, by_name) = start(
            &core,
            spec(
                &id,
                PortForwardKind::Pod,
                NAMESPACE,
                "direct",
                PortForwardPort::Name("http".into()),
            ),
        )
        .await;
        assert_eq!(get(by_name, "/hostname").await, "direct");
    })
    .await;
}

#[tokio::test]
#[ignore = "needs the sextant-e2e kind cluster"]
async fn keep_alive_and_parallel_connections_all_work() {
    const NAMESPACE: &str = "sextant-test-forward-many";
    let (core, id, client, _root) = kind_client().await;
    in_namespace(&client, NAMESPACE, async {
        create_pod(&client, NAMESPACE, web_pod("many", "many")).await;
        wait_ready(&client, NAMESPACE, "many").await;
        let (forward, port) = start(
            &core,
            spec(
                &id,
                PortForwardKind::Pod,
                NAMESPACE,
                "many",
                PortForwardPort::Number(8080),
            ),
        )
        .await;

        let mut first = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let mut second = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        for _ in 0..3 {
            assert!(get_keep_alive(&mut first, "/hostname")
                .await
                .contains("many"));
            assert!(get_keep_alive(&mut second, "/hostname")
                .await
                .contains("many"));
        }
        let listed = core.portforward_list();
        let forward_now = listed.iter().find(|entry| entry.id == forward).unwrap();
        assert_eq!(forward_now.active_connections, 2);

        let parallel = (0..8).map(|_| get(port, "/hostname"));
        for body in futures::future::join_all(parallel).await {
            assert_eq!(body, "many");
        }

        drop(first);
        drop(second);
        tokio::time::timeout(WAIT, async {
            loop {
                let listed = core.portforward_list();
                let entry = listed.iter().find(|entry| entry.id == forward).unwrap();
                if entry.active_connections == 0 {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("connections stayed counted after closing");
    })
    .await;
}

#[tokio::test]
#[ignore = "needs the sextant-e2e kind cluster"]
async fn a_service_forward_survives_pod_replacement_through_a_named_target_port() {
    const NAMESPACE: &str = "sextant-test-forward-service";
    let (core, id, client, _root) = kind_client().await;
    in_namespace(&client, NAMESPACE, async {
        create_pod(&client, NAMESPACE, web_pod("first", "web")).await;
        wait_ready(&client, NAMESPACE, "first").await;
        let service: Service = serde_json::from_value(json!({
            "metadata": { "name": "web" },
            "spec": {
                "selector": { "app": "web" },
                "ports": [{ "name": "front", "port": 80, "targetPort": "http" }],
            },
        }))
        .unwrap();
        let services: Api<Service> = Api::namespaced(client.clone(), NAMESPACE);
        services
            .create(&PostParams::default(), &service)
            .await
            .unwrap();
        let (forward, port) = start(
            &core,
            spec(
                &id,
                PortForwardKind::Service,
                NAMESPACE,
                "web",
                PortForwardPort::Number(80),
            ),
        )
        .await;
        assert_eq!(get(port, "/hostname").await, "first");

        let pods: Api<Pod> = Api::namespaced(client.clone(), NAMESPACE);
        pods.delete("first", &DeleteParams::default())
            .await
            .unwrap();
        create_pod(&client, NAMESPACE, web_pod("second", "web")).await;
        wait_ready(&client, NAMESPACE, "second").await;
        tokio::time::timeout(WAIT, async {
            while pods.get_opt("first").await.unwrap().is_some() {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(get(port, "/hostname").await, "second");
        let listed = core.portforward_list();
        let entry = listed.iter().find(|entry| entry.id == forward).unwrap();
        assert_eq!(entry.state, PortForwardState::Running);
    })
    .await;
}

#[tokio::test]
#[ignore = "needs the sextant-e2e kind cluster"]
async fn a_port_nothing_listens_on_sets_the_message_and_keeps_running() {
    const NAMESPACE: &str = "sextant-test-forward-refused";
    let (core, id, client, _root) = kind_client().await;
    in_namespace(&client, NAMESPACE, async {
        create_pod(&client, NAMESPACE, web_pod("quiet", "quiet")).await;
        wait_running(&client, NAMESPACE, "quiet").await;
        let (forward, port) = start(
            &core,
            spec(
                &id,
                PortForwardKind::Pod,
                NAMESPACE,
                "quiet",
                PortForwardPort::Number(9),
            ),
        )
        .await;
        let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let _ = socket.write_all(b"x").await;
        let mut buffer = [0; 16];
        let _ = tokio::time::timeout(WAIT, socket.read(&mut buffer)).await;
        tokio::time::timeout(WAIT, async {
            loop {
                let listed = core.portforward_list();
                let entry = listed.iter().find(|entry| entry.id == forward).unwrap();
                if entry.message.is_some() {
                    assert_eq!(entry.state, PortForwardState::Running);
                    return;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("no message was set");
    })
    .await;
}
