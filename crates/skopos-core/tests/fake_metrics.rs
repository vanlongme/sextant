//! Metrics (F16) against the fake API server: the setting, detection, Prometheus behind the
//! service proxy, and metrics.k8s.io snapshots.

mod support;

use k8s_openapi::jiff::Timestamp;
use serde_json::{json, Value};
use skopos_core::app_core::AppCore;
use skopos_core::error::{CoreResult, ErrorCode};
use skopos_core::kubeconfig::ClusterId;
use skopos_core::metrics::{MetricsProviderSetting, PrometheusScheme, UsageItem, UsageOf};
use skopos_fakekube::{DenyRule, FakeKubeConfig};
use support::connected_fake;

fn save_provider(
    core: &AppCore,
    id: &ClusterId,
    setting: MetricsProviderSetting,
) -> CoreResult<()> {
    let mut settings = core.cluster_settings_get(id);
    settings.metrics_provider = setting;
    core.cluster_settings_set(id, settings)
}

fn node_metrics(name: &str, timestamp: &str, cpu: &str, memory: &str) -> Value {
    json!({
        "metadata": { "name": name },
        "timestamp": timestamp,
        "window": "20s",
        "usage": { "cpu": cpu, "memory": memory },
    })
}

fn pod_metrics(namespace: &str, name: &str, containers: Value) -> Value {
    json!({
        "metadata": { "name": name, "namespace": namespace },
        "timestamp": "2026-11-09T10:00:00Z",
        "window": "20s",
        "containers": containers,
    })
}

fn container(cpu: &str, memory: &str) -> Value {
    json!({ "name": "main", "usage": { "cpu": cpu, "memory": memory } })
}

fn usage(namespace: Option<&str>, name: &str, cpu_cores: f64, memory_bytes: f64) -> UsageItem {
    UsageItem {
        namespace: namespace.map(str::to_owned),
        name: name.to_owned(),
        cpu_cores,
        memory_bytes,
    }
}

#[tokio::test]
async fn a_pinned_prometheus_is_saved_tidied_and_a_bad_one_is_refused() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    let pinned = |prefix: Option<&str>| MetricsProviderSetting::Prometheus {
        namespace: "monitoring".to_owned(),
        service: "prom".to_owned(),
        port: 9090,
        scheme: Some(PrometheusScheme::Https),
        path_prefix: prefix.map(str::to_owned),
    };
    save_provider(&core, &id, pinned(Some(" /prometheus/ "))).unwrap();
    assert_eq!(
        core.cluster_settings_get(&id).metrics_provider,
        pinned(Some("/prometheus"))
    );
    let err = save_provider(&core, &id, pinned(Some("prometheus"))).unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidInput);
    // A refused setting leaves the saved one.
    assert_eq!(
        core.cluster_settings_get(&id).metrics_provider,
        pinned(Some("/prometheus"))
    );
}

#[tokio::test]
async fn node_usage_comes_from_metrics_server_in_cores_and_bytes() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.serve_metrics_api(
        vec![
            node_metrics("worker", "2026-11-09T10:00:30Z", "1500m", "2Gi"),
            node_metrics(
                "control-plane",
                "2026-11-09T10:00:00Z",
                "250000000n",
                "512Mi",
            ),
            node_metrics("broken", "2026-11-09T10:00:45Z", "lots", "1Gi"),
        ],
        vec![],
    );

    let snapshot = core.metrics_usage(&id, UsageOf::Nodes, None).await.unwrap();
    assert_eq!(
        snapshot.items,
        [
            usage(None, "control-plane", 0.25, 536_870_912.0),
            usage(None, "worker", 1.5, 2_147_483_648.0),
        ]
    );
    // The newest item read; the one left out does not count.
    assert_eq!(snapshot.timestamp, "2026-11-09T10:00:30Z");
    // Nodes have no namespace, so one given is ignored.
    let again = core
        .metrics_usage(&id, UsageOf::Nodes, Some("shop"))
        .await
        .unwrap();
    assert_eq!(again.items, snapshot.items);
    assert_eq!(fake.request_count("/apis/metrics.k8s.io/v1beta1/nodes"), 2);
}

#[tokio::test]
async fn pod_usage_sums_containers_and_can_be_limited_to_a_namespace() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.serve_metrics_api(
        vec![],
        vec![
            pod_metrics(
                "shop",
                "web-2",
                json!([container("250m", "64Mi"), container("250m", "16Mi")]),
            ),
            pod_metrics("shop", "web-1", json!([container("10m", "8Mi")])),
            pod_metrics("kube-system", "dns", json!([container("5m", "32Mi")])),
            // A container without usage: the pod is left out rather than undercounted.
            pod_metrics(
                "shop",
                "half",
                json!([container("1m", "1Mi"), { "name": "sidecar" }]),
            ),
        ],
    );

    let all = core.metrics_usage(&id, UsageOf::Pods, None).await.unwrap();
    assert_eq!(
        all.items,
        [
            usage(Some("kube-system"), "dns", 0.005, 33_554_432.0),
            usage(Some("shop"), "web-1", 0.01, 8_388_608.0),
            usage(Some("shop"), "web-2", 0.5, 83_886_080.0),
        ]
    );
    let shop = core
        .metrics_usage(&id, UsageOf::Pods, Some("shop"))
        .await
        .unwrap();
    let names: Vec<&str> = shop.items.iter().map(|item| item.name.as_str()).collect();
    assert_eq!(names, ["web-1", "web-2"]);
    assert_eq!(
        fake.request_count("/apis/metrics.k8s.io/v1beta1/namespaces/shop/pods"),
        1
    );
}

#[tokio::test]
async fn without_metrics_server_usage_is_not_found() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    let err = core
        .metrics_usage(&id, UsageOf::Nodes, None)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
    assert_eq!(err.details.as_deref(), Some("noMetricsServer"));
}

#[tokio::test]
async fn usage_from_a_registered_but_unavailable_metrics_server_is_unreachable() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.serve_metrics_api(vec![], vec![]);
    fake.fail_metrics_api_with(503);
    let err = core
        .metrics_usage(&id, UsageOf::Pods, None)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Unreachable);
    assert_ne!(err.details.as_deref(), Some("noMetricsServer"));
}

#[tokio::test]
async fn usage_needs_the_list_right_and_a_usable_namespace() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig {
        deny: vec![DenyRule {
            verb: "list".into(),
            plural: "nodes.metrics.k8s.io".into(),
            namespace: None,
        }],
        ..Default::default()
    })
    .await;
    fake.serve_metrics_api(vec![], vec![]);

    let err = core
        .metrics_usage(&id, UsageOf::Nodes, None)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Forbidden);
    let err = core
        .metrics_usage(&id, UsageOf::Pods, Some("a/b"))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidInput);
    // Pods are still readable.
    let pods = core.metrics_usage(&id, UsageOf::Pods, None).await.unwrap();
    assert!(pods.items.is_empty());
}

#[tokio::test]
async fn an_empty_snapshot_is_stamped_now() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.serve_metrics_api(vec![], vec![]);
    let before = Timestamp::now();
    let snapshot = core
        .metrics_usage(&id, UsageOf::Pods, Some("shop"))
        .await
        .unwrap();
    let after = Timestamp::now();
    assert!(snapshot.items.is_empty());
    let stamped: Timestamp = snapshot.timestamp.parse().unwrap();
    assert!(before <= stamped && stamped <= after, "{stamped}");
}
