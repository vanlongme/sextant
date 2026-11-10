//! Metrics (F16) against the fake API server: the setting, detection, Prometheus behind the
//! service proxy, and metrics.k8s.io snapshots.

mod support;

use std::time::Duration;

use k8s_openapi::jiff::Timestamp;
use serde_json::{json, Value};
use skopos_core::app_core::AppCore;
use skopos_core::error::{CoreResult, ErrorCode};
use skopos_core::kubeconfig::ClusterId;
use skopos_core::metrics::{
    MetricName, MetricsLimits, MetricsProvider, MetricsProviderSetting, MetricsRange,
    MetricsServerChoice, MetricsTarget, NoProviderChoice, PrometheusChoice, PrometheusScheme,
    UsageItem, UsageOf, WorkloadKind,
};
use skopos_fakekube::{DenyRule, FakeKube, FakeKubeConfig, ProxyReply, ProxyRequest};
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

fn prometheus_service(
    namespace: &str,
    name: &str,
    labels: Value,
    port_name: &str,
    port: u16,
) -> Value {
    json!({
        "metadata": { "namespace": namespace, "name": name, "labels": labels },
        "spec": { "ports": [{ "name": port_name, "port": port, "protocol": "TCP" }] },
    })
}

fn kube_prometheus_stack(fake: &FakeKube) {
    fake.upsert(
        "services",
        prometheus_service(
            "monitoring",
            "kps-prometheus",
            json!({ "app": "kube-prometheus-stack-prometheus" }),
            "http-web",
            9090,
        ),
    );
}

/// What Prometheus answers to the detection probe.
fn up(_: &ProxyRequest) -> ProxyReply {
    ProxyReply::json(
        200,
        json!({ "status": "success", "data": { "resultType": "vector", "result": [] } }),
    )
}

/// The community chart's server in `metrics`, answering `handler`.
fn community_chart(
    fake: &FakeKube,
    handler: impl Fn(&ProxyRequest) -> ProxyReply + Send + Sync + 'static,
) {
    fake.upsert(
        "services",
        prometheus_service(
            "metrics",
            "prometheus-server",
            json!({ "app.kubernetes.io/name": "prometheus", "app.kubernetes.io/component": "server" }),
            "http",
            80,
        ),
    );
    fake.serve_proxy("metrics", "prometheus-server:80", handler);
}

fn chart_provider() -> MetricsProvider {
    MetricsProvider::Prometheus {
        namespace: "metrics".to_owned(),
        service: "prometheus-server".to_owned(),
        port: 80,
        chosen_by: PrometheusChoice::CommunityChart,
    }
}

/// Prometheus: the probe answers `up`, and every range query answers `range`.
fn prometheus(
    range: impl Fn(&ProxyRequest) -> ProxyReply + Send + Sync + 'static,
) -> impl Fn(&ProxyRequest) -> ProxyReply + Send + Sync + 'static {
    move |request| {
        if request.path.ends_with("/api/v1/query_range") {
            range(request)
        } else {
            up(request)
        }
    }
}

/// A range answer: one series with `values` at `start`, `start + step`, and so on.
fn matrix(request: &ProxyRequest, values: &[f64]) -> ProxyReply {
    let start: i64 = request.params["start"].parse().unwrap();
    let step: i64 = request.params["step"].parse().unwrap();
    let points: Vec<Value> = values
        .iter()
        .zip(0_i64..)
        .map(|(value, i)| json!([start + step * i, value.to_string()]))
        .collect();
    ProxyReply::json(
        200,
        json!({
            "status": "success",
            "data": { "resultType": "matrix", "result": [{ "metric": {}, "values": points }] },
        }),
    )
}

fn no_samples(_: &ProxyRequest) -> ProxyReply {
    ProxyReply::json(
        200,
        json!({ "status": "success", "data": { "resultType": "matrix", "result": [] } }),
    )
}

fn range_requests(fake: &FakeKube, namespace: &str, service: &str) -> Vec<ProxyRequest> {
    fake.proxy_requests(namespace, service)
        .into_iter()
        .filter(|request| request.path.ends_with("/api/v1/query_range"))
        .collect()
}

fn pinned_prometheus(
    scheme: Option<PrometheusScheme>,
    path_prefix: Option<&str>,
) -> MetricsProviderSetting {
    MetricsProviderSetting::Prometheus {
        namespace: "monitoring".to_owned(),
        service: "prom".to_owned(),
        port: 9090,
        scheme,
        path_prefix: path_prefix.map(str::to_owned),
    }
}

fn web_deployment() -> Value {
    json!({
        "apiVersion": "apps/v1",
        "kind": "Deployment",
        "metadata": { "namespace": "default", "name": "web" },
        "spec": {
            "selector": { "matchLabels": { "app": "web" } },
            "template": { "metadata": { "labels": { "app": "web" } }, "spec": { "containers": [] } },
        },
    })
}

fn labelled_pod(name: &str, app: &str) -> Value {
    json!({
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": { "namespace": "default", "name": name, "labels": { "app": app } },
        "spec": { "containers": [{ "name": "main", "image": "web" }] },
        "status": { "phase": "Running" },
    })
}

fn web_target() -> MetricsTarget {
    MetricsTarget::Workload {
        namespace: "default".to_owned(),
        name: "web".to_owned(),
        workload_kind: WorkloadKind::Deployment,
    }
}

fn web_pod() -> MetricsTarget {
    MetricsTarget::Pod {
        namespace: "default".to_owned(),
        name: "web-1".to_owned(),
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

#[tokio::test]
async fn auto_picks_the_first_candidate_that_answers_the_probe() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    // A higher tier, but nothing answers behind it.
    kube_prometheus_stack(&fake);
    community_chart(&fake, up);
    // A lower tier, never probed.
    fake.upsert(
        "services",
        prometheus_service(
            "default",
            "my-prometheus",
            json!({ "app.kubernetes.io/name": "prometheus" }),
            "web",
            9090,
        ),
    );
    fake.serve_proxy("default", "my-prometheus:9090", up);

    assert_eq!(
        core.metrics_provider(&id, false).await.unwrap(),
        chart_provider()
    );
    assert_eq!(
        fake.proxy_requests("monitoring", "kps-prometheus:9090")
            .len(),
        1
    );
    let probes = fake.proxy_requests("metrics", "prometheus-server:80");
    assert_eq!(probes.len(), 1);
    assert_eq!(probes[0].path, "/api/v1/query");
    assert_eq!(
        probes[0].params.get("query").map(String::as_str),
        Some("up")
    );
    assert!(fake
        .proxy_requests("default", "my-prometheus:9090")
        .is_empty());
}

#[tokio::test]
async fn a_probe_that_is_refused_or_too_slow_moves_on() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig {
        deny: vec![DenyRule {
            verb: "get".into(),
            plural: "services/proxy".into(),
            namespace: Some("monitoring".into()),
        }],
        ..Default::default()
    })
    .await;
    core.set_metrics_limits_for_test(MetricsLimits {
        probe: Duration::from_millis(300),
        ..MetricsLimits::default()
    });
    kube_prometheus_stack(&fake);
    fake.serve_proxy("monitoring", "kps-prometheus:9090", up);
    fake.upsert(
        "services",
        prometheus_service(
            "obs",
            "prometheus-operated",
            json!({ "operated-prometheus": "true" }),
            "web",
            9090,
        ),
    );
    fake.serve_proxy("obs", "prometheus-operated:9090", |request| {
        up(request).after(Duration::from_secs(3))
    });
    community_chart(&fake, up);

    assert_eq!(
        core.metrics_provider(&id, false).await.unwrap(),
        chart_provider()
    );
    assert_eq!(
        fake.proxy_requests("obs", "prometheus-operated:9090").len(),
        1
    );
}

#[tokio::test]
async fn without_prometheus_auto_falls_back_to_metrics_server_or_to_none() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    let nothing = MetricsProvider::Off {
        chosen_by: NoProviderChoice::NothingFound,
    };
    assert_eq!(core.metrics_provider(&id, false).await.unwrap(), nothing);

    fake.serve_metrics_api(vec![], vec![]);
    assert_eq!(
        core.metrics_provider(&id, true).await.unwrap(),
        MetricsProvider::MetricsServer {
            chosen_by: MetricsServerChoice::Fallback,
        }
    );
    // Registered, but unavailable.
    fake.fail_metrics_api_with(503);
    assert_eq!(core.metrics_provider(&id, true).await.unwrap(), nothing);
}

#[tokio::test]
async fn a_setting_is_used_as_is_without_detection() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    save_provider(
        &core,
        &id,
        MetricsProviderSetting::Prometheus {
            namespace: "monitoring".to_owned(),
            service: "prom".to_owned(),
            port: 9090,
            scheme: None,
            path_prefix: None,
        },
    )
    .unwrap();
    assert_eq!(
        core.metrics_provider(&id, false).await.unwrap(),
        MetricsProvider::Prometheus {
            namespace: "monitoring".to_owned(),
            service: "prom".to_owned(),
            port: 9090,
            chosen_by: PrometheusChoice::Setting,
        }
    );
    save_provider(&core, &id, MetricsProviderSetting::MetricsServer).unwrap();
    assert_eq!(
        core.metrics_provider(&id, true).await.unwrap(),
        MetricsProvider::MetricsServer {
            chosen_by: MetricsServerChoice::Setting,
        }
    );
    save_provider(&core, &id, MetricsProviderSetting::Off).unwrap();
    assert_eq!(
        core.metrics_provider(&id, false).await.unwrap(),
        MetricsProvider::Off {
            chosen_by: NoProviderChoice::Setting,
        }
    );
    assert_eq!(fake.request_count("/api/v1/services"), 0);
    assert!(fake.proxy_requests("monitoring", "prom:9090").is_empty());
}

#[tokio::test]
async fn detection_is_cached_until_refresh_a_settings_change_a_reconnect_or_expiry() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    community_chart(&fake, up);
    let detections = || fake.request_count("/api/v1/services");

    assert_eq!(
        core.metrics_provider(&id, false).await.unwrap(),
        chart_provider()
    );
    assert_eq!(
        core.metrics_provider(&id, false).await.unwrap(),
        chart_provider()
    );
    assert_eq!(detections(), 1);

    core.metrics_provider(&id, true).await.unwrap();
    assert_eq!(detections(), 2);

    save_provider(&core, &id, MetricsProviderSetting::Off).unwrap();
    core.metrics_provider(&id, false).await.unwrap();
    save_provider(&core, &id, MetricsProviderSetting::Auto).unwrap();
    core.metrics_provider(&id, false).await.unwrap();
    assert_eq!(detections(), 3);
    // Saving the same setting again keeps the detection.
    save_provider(&core, &id, MetricsProviderSetting::Auto).unwrap();
    core.metrics_provider(&id, false).await.unwrap();
    assert_eq!(detections(), 3);

    core.cluster_disconnect(&id).await.unwrap();
    let err = core.metrics_provider(&id, false).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Unreachable);
    core.cluster_connect(&id).await.unwrap();
    core.metrics_provider(&id, false).await.unwrap();
    assert_eq!(detections(), 4);

    core.set_metrics_limits_for_test(MetricsLimits {
        cache: Duration::from_millis(200),
        ..MetricsLimits::default()
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    core.metrics_provider(&id, false).await.unwrap();
    assert_eq!(detections(), 5);
}

#[tokio::test]
async fn a_forbidden_service_list_falls_back_to_each_namespace() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig {
        namespaces: vec!["default".into(), "metrics".into(), "shop".into()],
        deny_cluster_wide: vec![DenyRule {
            verb: "list".into(),
            plural: "services".into(),
            namespace: None,
        }],
        deny: vec![DenyRule {
            verb: "list".into(),
            plural: "services".into(),
            namespace: Some("shop".into()),
        }],
        ..Default::default()
    })
    .await;
    community_chart(&fake, up);

    assert_eq!(
        core.metrics_provider(&id, false).await.unwrap(),
        chart_provider()
    );
    assert_eq!(fake.request_count("/api/v1/services"), 1);
    assert_eq!(fake.request_count("/api/v1/namespaces/metrics/services"), 1);
    // Refused, and skipped.
    assert_eq!(fake.request_count("/api/v1/namespaces/shop/services"), 1);
}

#[tokio::test]
async fn a_cluster_query_returns_each_series_and_lists_the_metrics_without_data() {
    use MetricName::*;
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    community_chart(
        &fake,
        prometheus(|request| {
            let query = &request.params["query"];
            if query.contains("node_cpu_seconds_total") {
                matrix(request, &[0.5, 0.75])
            } else if query.contains(r#"kube_node_status_capacity{resource="cpu"}"#) {
                matrix(request, &[4.0])
            } else {
                no_samples(request)
            }
        }),
    );

    let result = core
        .metrics_query(&id, &MetricsTarget::Cluster, MetricsRange::OneHour)
        .await
        .unwrap();
    let now = Timestamp::now().as_second();
    assert_eq!(result.step, 60);
    assert_eq!(result.end - result.start, 3_600);
    assert_eq!(result.end % 60, 0);
    assert!(
        result.end <= now && now - result.end < 120,
        "{} {now}",
        result.end
    );
    let start = result.start as f64;
    assert_eq!(result.series.len(), 2);
    assert_eq!(
        result.series[&CpuUsage],
        [(start, 0.5), (start + 60.0, 0.75)]
    );
    assert_eq!(result.series[&CpuCapacity], [(start, 4.0)]);
    assert_eq!(
        result.missing,
        [
            CpuRequests,
            CpuLimits,
            CpuAllocatable,
            MemoryUsage,
            MemoryRequests,
            MemoryLimits,
            MemoryAllocatable,
            MemoryCapacity,
            PodUsage,
            PodAllocatable,
            PodCapacity,
            DiskUsage,
            DiskCapacity,
        ]
    );

    let ranges = range_requests(&fake, "metrics", "prometheus-server:80");
    assert_eq!(ranges.len(), 15);
    for request in &ranges {
        assert_eq!(request.method, "GET");
        assert_eq!(request.params["start"], result.start.to_string());
        assert_eq!(request.params["end"], result.end.to_string());
        assert_eq!(request.params["step"], "60");
    }
    assert!(ranges.iter().any(|request| request.params["query"]
        == r#"sum(rate(node_cpu_seconds_total{mode!~"idle|iowait|steal"}[120s]))"#));
}

#[tokio::test]
async fn a_pinned_prometheus_is_reached_with_its_scheme_and_path_prefix() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    save_provider(
        &core,
        &id,
        pinned_prometheus(Some(PrometheusScheme::Https), Some("/prom")),
    )
    .unwrap();
    fake.serve_proxy("monitoring", "https:prom:9090", |request| {
        matrix(request, &[1.0])
    });

    let node = MetricsTarget::Node {
        name: "worker".to_owned(),
    };
    let result = core
        .metrics_query(&id, &node, MetricsRange::SixHours)
        .await
        .unwrap();
    assert_eq!(result.step, 300);
    assert_eq!(result.series.len(), 15);
    assert!(result.missing.is_empty());
    // No probe for a pinned Service: every request is a range query.
    let requests = fake.proxy_requests("monitoring", "https:prom:9090");
    assert_eq!(requests.len(), 15);
    assert!(requests
        .iter()
        .all(|request| request.path == "/prom/api/v1/query_range"));
    assert!(requests
        .iter()
        .any(|request| request.params["query"].contains(r#"node_uname_info{nodename="worker"}"#)));
}

#[tokio::test]
async fn a_workload_reads_the_pods_its_selector_matches_now() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    community_chart(&fake, prometheus(|request| matrix(request, &[1.0])));
    fake.upsert("deployments", web_deployment());
    fake.upsert("pods", labelled_pod("web-1", "web"));
    fake.upsert("pods", labelled_pod("web-2", "web"));
    fake.upsert("pods", labelled_pod("api-1", "api"));

    let result = core
        .metrics_query(&id, &web_target(), MetricsRange::OneHour)
        .await
        .unwrap();
    assert_eq!(result.series.len(), 11);
    let ranges = range_requests(&fake, "metrics", "prometheus-server:80");
    assert_eq!(ranges.len(), 11);
    for request in &ranges {
        let query = &request.params["query"];
        assert!(
            query.contains(r#"namespace="default", pod=~"^(?:web-1|web-2)$""#),
            "{query}"
        );
    }
}

#[tokio::test]
async fn a_workload_without_pods_has_every_metric_missing_and_sends_no_query() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    community_chart(&fake, prometheus(|request| matrix(request, &[1.0])));
    fake.upsert("deployments", web_deployment());
    fake.upsert("pods", labelled_pod("api-1", "api"));

    let result = core
        .metrics_query(&id, &web_target(), MetricsRange::OneHour)
        .await
        .unwrap();
    assert!(result.series.is_empty());
    assert_eq!(result.missing.len(), 11);
    assert!(range_requests(&fake, "metrics", "prometheus-server:80").is_empty());
}

#[tokio::test]
async fn a_workload_that_does_not_exist_is_not_found() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    community_chart(&fake, prometheus(no_samples));
    let err = core
        .metrics_query(&id, &web_target(), MetricsRange::OneHour)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
}

#[tokio::test]
async fn a_query_string_over_8_kib_goes_as_a_form_post() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    community_chart(&fake, prometheus(|request| matrix(request, &[1.0])));
    fake.upsert("deployments", web_deployment());
    // 40 pods with names of 227 characters: the alternation alone passes 8 KiB.
    let names: Vec<String> = (0..40)
        .map(|i| format!("web-{i:02}-{}", "x".repeat(220)))
        .collect();
    for name in &names {
        fake.upsert("pods", labelled_pod(name, "web"));
    }

    let result = core
        .metrics_query(&id, &web_target(), MetricsRange::OneHour)
        .await
        .unwrap();
    assert_eq!(result.series.len(), 11);
    let ranges = range_requests(&fake, "metrics", "prometheus-server:80");
    assert_eq!(ranges.len(), 11);
    for request in &ranges {
        assert_eq!(request.method, "POST");
        assert_eq!(
            request.content_type.as_deref(),
            Some("application/x-www-form-urlencoded")
        );
        assert!(request.params["query"].contains(&names[39]));
        assert_eq!(request.params["step"], "60");
    }
}

#[tokio::test]
async fn without_services_proxy_rights_the_query_is_forbidden_and_names_the_permission() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig {
        deny: vec![DenyRule {
            verb: "get".into(),
            plural: "services/proxy".into(),
            namespace: Some("monitoring".into()),
        }],
        ..Default::default()
    })
    .await;
    save_provider(&core, &id, pinned_prometheus(None, None)).unwrap();
    fake.serve_proxy("monitoring", "prom:9090", |request| matrix(request, &[1.0]));

    let err = core
        .metrics_query(&id, &MetricsTarget::Cluster, MetricsRange::OneHour)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Forbidden);
    assert!(
        err.message
            .contains("needs permission to get services/proxy in namespace monitoring"),
        "{}",
        err.message
    );
}

#[tokio::test]
async fn a_query_that_times_out_is_missing_and_when_all_do_the_call_is_unreachable() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    core.set_metrics_limits_for_test(MetricsLimits {
        query: Duration::from_millis(300),
        ..MetricsLimits::default()
    });
    community_chart(
        &fake,
        prometheus(|request| {
            let reply = matrix(request, &[1.0]);
            if request.params["query"].contains("container_cpu_usage_seconds_total") {
                reply.after(Duration::from_secs(2))
            } else {
                reply
            }
        }),
    );

    let result = core
        .metrics_query(&id, &web_pod(), MetricsRange::OneHour)
        .await
        .unwrap();
    assert_eq!(result.missing, [MetricName::CpuUsage]);
    assert_eq!(result.series.len(), 10);

    fake.serve_proxy(
        "metrics",
        "prometheus-server:80",
        prometheus(|request| matrix(request, &[1.0]).after(Duration::from_secs(2))),
    );
    let err = core
        .metrics_query(&id, &web_pod(), MetricsRange::OneHour)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Unreachable);
}

#[tokio::test]
async fn when_every_query_fails_the_first_failure_rejects_and_detection_runs_again() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    community_chart(
        &fake,
        prometheus(|_| {
            ProxyReply::json(
                400,
                json!({ "status": "error", "errorType": "bad_data", "error": "parse error" }),
            )
        }),
    );

    let err = core
        .metrics_query(&id, &MetricsTarget::Cluster, MetricsRange::OneHour)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Internal);
    assert_eq!(err.message, "parse error");
    assert_eq!(fake.request_count("/api/v1/services"), 1);
    core.metrics_query(&id, &MetricsTarget::Cluster, MetricsRange::OneHour)
        .await
        .unwrap_err();
    assert_eq!(fake.request_count("/api/v1/services"), 2);
}

#[tokio::test]
async fn a_not_found_from_prometheus_keeps_the_answers_and_drops_the_detection() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    community_chart(
        &fake,
        prometheus(|request| {
            if request.params["query"].contains("node_cpu_seconds_total") {
                ProxyReply::text(404, "404 page not found")
            } else {
                matrix(request, &[1.0])
            }
        }),
    );

    let result = core
        .metrics_query(&id, &MetricsTarget::Cluster, MetricsRange::OneHour)
        .await
        .unwrap();
    assert_eq!(result.missing, [MetricName::CpuUsage]);
    assert_eq!(fake.request_count("/api/v1/services"), 1);
    core.metrics_provider(&id, false).await.unwrap();
    assert_eq!(fake.request_count("/api/v1/services"), 2);
}

#[tokio::test]
async fn without_prometheus_the_query_is_not_found_with_no_prometheus() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    // Pinned to metrics-server, then detected as nothing.
    for setting in [
        MetricsProviderSetting::MetricsServer,
        MetricsProviderSetting::Auto,
    ] {
        save_provider(&core, &id, setting).unwrap();
        let err = core
            .metrics_query(&id, &MetricsTarget::Cluster, MetricsRange::OneHour)
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
        assert_eq!(err.details.as_deref(), Some("noPrometheus"));
    }
}

#[tokio::test]
async fn an_unusable_target_is_refused_before_anything_is_read() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    let targets = [
        MetricsTarget::Node {
            name: String::new(),
        },
        MetricsTarget::Workload {
            namespace: "a/b".to_owned(),
            name: "web".to_owned(),
            workload_kind: WorkloadKind::Deployment,
        },
        MetricsTarget::Pvc {
            namespace: "default".to_owned(),
            name: "../data".to_owned(),
        },
    ];
    for target in targets {
        let err = core
            .metrics_query(&id, &target, MetricsRange::OneHour)
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidInput, "{target:?}");
    }
    assert_eq!(fake.request_count("/api/v1/services"), 0);
}
