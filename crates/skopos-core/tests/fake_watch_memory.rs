//! How much the watch hub keeps for each watched object. Alone in its binary, since
//! the allocator below counts every allocation of the process.

mod support;

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicIsize, Ordering};
use std::time::Duration;

use serde_json::{json, Value};
use skopos_core::resources::{ResourceRef, WatchEvent};
use skopos_fakekube::FakeKubeConfig;
use support::connected_fake;
use tokio::sync::mpsc;

const PODS: usize = 1000;
const WAIT: Duration = Duration::from_secs(30);

/// The bytes the process holds right now, as requested from the allocator.
static LIVE: AtomicIsize = AtomicIsize::new(0);

struct Counting;

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let ptr = unsafe { System.alloc(layout) };
        if !ptr.is_null() {
            LIVE.fetch_add(layout.size() as isize, Ordering::Relaxed);
        }
        ptr
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) };
        LIVE.fetch_sub(layout.size() as isize, Ordering::Relaxed);
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let moved = unsafe { System.realloc(ptr, layout, new_size) };
        if !moved.is_null() {
            LIVE.fetch_add(
                new_size as isize - layout.size() as isize,
                Ordering::Relaxed,
            );
        }
        moved
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

/// A pod shaped like one a Deployment makes, about 6 KB of JSON whole and 1 KB as a row.
fn pod(n: usize) -> Value {
    let name = format!("web-7d9c6b5f4d-{n:05}");
    let container = |which: &str| {
        let env: Vec<Value> = (0..8)
            .map(|i| json!({ "name": format!("SETTING_{i}"), "value": format!("value-{i}") }))
            .chain([json!({
                "name": "POD_NAME",
                "valueFrom": { "fieldRef": { "apiVersion": "v1", "fieldPath": "metadata.name" } },
            })])
            .collect();
        json!({
            "name": which,
            "image": format!("registry.example.com/team/{which}:1.27.3"),
            "imagePullPolicy": "IfNotPresent",
            "args": ["--port=8080", "--log-level=info"],
            "env": env,
            "ports": [
                { "name": "http", "containerPort": 8080, "protocol": "TCP" },
                { "name": "metrics", "containerPort": 9090, "protocol": "TCP" },
            ],
            "resources": {
                "limits": { "cpu": "500m", "memory": "256Mi" },
                "requests": { "cpu": "100m", "memory": "128Mi" },
            },
            "volumeMounts": [
                { "name": "config", "mountPath": "/etc/app", "readOnly": true },
                { "name": "data", "mountPath": "/var/lib/app" },
                { "name": "kube-api-access-x7k2p", "mountPath": "/var/run/secrets/kubernetes.io/serviceaccount", "readOnly": true },
            ],
            "livenessProbe": {
                "httpGet": { "path": "/healthz", "port": 8080, "scheme": "HTTP" },
                "initialDelaySeconds": 10, "periodSeconds": 10, "timeoutSeconds": 1,
                "successThreshold": 1, "failureThreshold": 3,
            },
            "readinessProbe": {
                "httpGet": { "path": "/ready", "port": 8080, "scheme": "HTTP" },
                "periodSeconds": 5, "timeoutSeconds": 1, "successThreshold": 1, "failureThreshold": 3,
            },
            "securityContext": { "allowPrivilegeEscalation": false, "runAsNonRoot": true },
            "terminationMessagePath": "/dev/termination-log",
            "terminationMessagePolicy": "File",
        })
    };
    let status = |which: &str| {
        json!({
            "name": which,
            "image": format!("registry.example.com/team/{which}:1.27.3"),
            "imageID": format!("registry.example.com/team/{which}@sha256:4f1e8c0d2b7a9e6c3d5f8a1b0c2e4d6f8a0b1c3d5e7f9a2b4c6d8e0f1a3b5c7d"),
            "containerID": format!("containerd://{n:064}"),
            "ready": true, "started": true, "restartCount": 0,
            "state": { "running": { "startedAt": "2026-11-01T08:00:05Z" } },
            "lastState": {},
        })
    };
    let conditions: Vec<Value> = [
        "PodReadyToStartContainers",
        "Initialized",
        "Ready",
        "ContainersReady",
        "PodScheduled",
    ]
    .map(|kind| json!({ "type": kind, "status": "True", "lastProbeTime": null, "lastTransitionTime": "2026-11-01T08:00:06Z" }))
    .into();
    json!({
        "metadata": {
            "name": name,
            "generateName": "web-7d9c6b5f4d-",
            "namespace": format!("team-{}", n % 10),
            "creationTimestamp": "2026-11-01T08:00:00Z",
            "labels": {
                "app.kubernetes.io/name": "web",
                "app.kubernetes.io/instance": "web-prod",
                "app.kubernetes.io/version": "1.27.3",
                "pod-template-hash": "7d9c6b5f4d",
            },
            "annotations": {
                "prometheus.io/scrape": "true",
                "prometheus.io/port": "9090",
            },
            "ownerReferences": [{
                "apiVersion": "apps/v1", "kind": "ReplicaSet", "name": "web-7d9c6b5f4d",
                "uid": "0b6f3c1e-5a2d-4c7e-9f8b-1d2e3f4a5b6c", "controller": true, "blockOwnerDeletion": true,
            }],
        },
        "spec": {
            "containers": [container("app"), container("sidecar")],
            "volumes": [
                { "name": "config", "configMap": { "name": "web-config", "defaultMode": 420 } },
                { "name": "data", "emptyDir": {} },
                { "name": "kube-api-access-x7k2p", "projected": { "defaultMode": 420, "sources": [
                    { "serviceAccountToken": { "expirationSeconds": 3607, "path": "token" } },
                    { "configMap": { "name": "kube-root-ca.crt", "items": [{ "key": "ca.crt", "path": "ca.crt" }] } },
                    { "downwardAPI": { "items": [{ "path": "namespace", "fieldRef": { "apiVersion": "v1", "fieldPath": "metadata.namespace" } }] } },
                ] } },
            ],
            "dnsPolicy": "ClusterFirst",
            "enableServiceLinks": true,
            "nodeName": format!("node-{}", n % 20),
            "preemptionPolicy": "PreemptLowerPriority",
            "priority": 0,
            "restartPolicy": "Always",
            "schedulerName": "default-scheduler",
            "securityContext": {},
            "serviceAccount": "web",
            "serviceAccountName": "web",
            "terminationGracePeriodSeconds": 30,
            "tolerations": [
                { "effect": "NoExecute", "key": "node.kubernetes.io/not-ready", "operator": "Exists", "tolerationSeconds": 300 },
                { "effect": "NoExecute", "key": "node.kubernetes.io/unreachable", "operator": "Exists", "tolerationSeconds": 300 },
            ],
        },
        "status": {
            "phase": "Running",
            "conditions": conditions,
            "containerStatuses": [status("app"), status("sidecar")],
            "hostIP": "10.0.0.17",
            "hostIPs": [{ "ip": "10.0.0.17" }],
            "podIP": "10.244.3.41",
            "podIPs": [{ "ip": "10.244.3.41" }],
            "qosClass": "Burstable",
            "startTime": "2026-11-01T08:00:00Z",
        },
    })
}

/// A watched object stays about the size of its JSON, so that a cluster with
/// thousands of pods does not cost the app a gigabyte.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_hub_keeps_a_watched_object_in_about_the_size_of_its_json() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    for n in 0..PODS {
        fake.upsert("pods", pod(n));
    }
    let before = LIVE.load(Ordering::Relaxed);

    let (tx, mut rx) = mpsc::channel(64);
    let resource = ResourceRef {
        group: String::new(),
        version: "v1".into(),
        plural: "pods".into(),
        kind: "Pod".into(),
        namespaced: true,
    };
    core.resources_subscribe(&id, resource, tx).await.unwrap();
    let text = loop {
        let event = tokio::time::timeout(WAIT, rx.recv())
            .await
            .expect("timed out waiting for the snapshot")
            .expect("closed before the snapshot");
        if let WatchEvent::Snapshot { items } = event {
            assert_eq!(items.len(), PODS);
            break items
                .iter()
                .map(|item| serde_json::to_string(item).unwrap().len())
                .sum::<usize>();
        }
    };
    // What the listing needed only for a moment is gone by now.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let kept = (LIVE.load(Ordering::Relaxed) - before).max(0) as usize;

    let per_object = kept / PODS;
    let json_per_object = text / PODS;
    // A Pod row is trimmed to about 1 KB, so the key, the map entry and the watch's own
    // share weigh as much as the text. A parsed tree would cost about ten times the text.
    assert!(
        per_object < json_per_object * 3 / 2 + 1024,
        "the hub keeps {per_object} bytes for each object of {json_per_object} bytes of JSON"
    );
    drop(rx);
}
