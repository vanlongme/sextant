//! Metrics (F16) against a real Prometheus and metrics-server on the skopos-e2e kind cluster.
//! `make test-metrics` runs it: scripts/metrics-up.sh installs metrics-server, the Prometheus
//! test installs the prometheus-community chart with the app's own Helm code, and
//! scripts/metrics-down.sh removes both, pass or fail.

mod support;

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::core::v1::Pod;
use k8s_openapi::jiff::Timestamp;
use kube::api::{ListParams, PostParams};
use kube::{Api, Client};
use serde_json::json;
use skopos_core::app_core::AppCore;
use skopos_core::helm::{ChartRef, HelmHomes, HelmInstallRequest, HelmRepoAdd};
use skopos_core::kubeconfig::ClusterId;
use skopos_core::metrics::{
    MetricName, MetricsProvider, MetricsRange, MetricsResult, MetricsTarget, PrometheusChoice,
    UsageOf, UsageSnapshot, WorkloadKind,
};
use skopos_core::paths::AppPaths;
use skopos_core::sessions::{SessionEvent, SessionOutput};
use skopos_core::tools::{ToolName, ToolsConfig};
use support::{connected_kind, in_namespace, TEST_IMAGE};
use tokio::sync::mpsc;

const CHART_REPO: &str = "https://prometheus-community.github.io/helm-charts";
const CHART_VERSION: &str = "29.45.1";
const RELEASE: &str = "skopos-prometheus";
const RELEASE_NAMESPACE: &str = "skopos-metrics";
/// scripts/metrics-down.sh deletes these namespaces too.
const QUERY_NAMESPACE: &str = "skopos-metrics-query";
const USAGE_NAMESPACE: &str = "skopos-metrics-usage";
const NODES: [&str; 2] = ["skopos-e2e-control-plane", "skopos-e2e-worker"];
/// helm waits on image pulls.
const INSTALL_WAIT: Duration = Duration::from_secs(600);
/// A few scrapes, and two for a rate.
const DATA_WAIT: Duration = Duration::from_secs(300);
/// No PersistentVolume, alertmanager or pushgateway; a scrape every 15 s; the server and
/// kube-state-metrics on the control-plane node.
const VALUES: &str = r#"alertmanager:
  enabled: false
prometheus-pushgateway:
  enabled: false
server:
  global:
    scrape_interval: 15s
  persistentVolume:
    enabled: false
  nodeSelector:
    kubernetes.io/hostname: skopos-e2e-control-plane
  tolerations:
    - key: node-role.kubernetes.io/control-plane
      operator: Exists
      effect: NoSchedule
kube-state-metrics:
  nodeSelector:
    kubernetes.io/hostname: skopos-e2e-control-plane
  tolerations:
    - key: node-role.kubernetes.io/control-plane
      operator: Exists
      effect: NoSchedule
"#;
/// Writes and reads 20 MiB so the filesystem counters move, then serves HTTP.
const WEB_SCRIPT: &str = "dd if=/dev/zero of=/scratch/f bs=1M count=20 conv=fsync \
    && dd if=/scratch/f of=/dev/null bs=1M && exec /agnhost netexec --http-port=8080";

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// The managed helm in e2e/.tmp/tools, downloaded on the first run and reused after that.
async fn managed_helm() -> String {
    let home = tempfile::tempdir().unwrap();
    let paths = AppPaths::under(&repo_root().join("e2e/.tmp/tools"), home.path());
    let core = AppCore::start_with_kubeconfig_env(paths, None)
        .await
        .unwrap();
    // Only the managed copy counts, whatever is on PATH.
    core.set_tools_config_for_test(ToolsConfig {
        search_path: Some(OsString::new()),
        ..ToolsConfig::default()
    });
    let status = core.tools_download(ToolName::Helm).await.unwrap();
    core.shutdown().await;
    status.path.unwrap()
}

/// Makes `core` run `helm`, with helm's folders inside `root`.
fn use_helm(core: &AppCore, helm: &str, root: &Path) {
    let folder = Path::new(helm).parent().unwrap();
    core.set_tools_config_for_test(ToolsConfig {
        search_path: Some(folder.as_os_str().to_owned()),
        ..ToolsConfig::default()
    });
    let homes = root.join("helm");
    core.set_helm_homes_for_test(HelmHomes {
        config: homes.join("config"),
        cache: homes.join("cache"),
        data: homes.join("data"),
    });
}

/// The session's output, and the event it ended with.
async fn session_output(mut output: mpsc::Receiver<SessionOutput>) -> (String, SessionEvent) {
    let mut data = Vec::new();
    let collect = async {
        loop {
            match output
                .recv()
                .await
                .expect("the session sent its last event")
            {
                SessionOutput::Data(bytes) => data.extend(bytes),
                SessionOutput::Event(
                    last @ (SessionEvent::Exited { .. } | SessionEvent::Failed { .. }),
                ) => break last,
                SessionOutput::Event(_) => {}
            }
        }
    };
    let last = tokio::time::timeout(INSTALL_WAIT, collect)
        .await
        .expect("the session ended");
    (String::from_utf8_lossy(&data).into_owned(), last)
}

/// Installs the community chart through the app's own Helm code, and waits for it.
async fn install_prometheus(core: &AppCore, id: &ClusterId, root: &Path) {
    let helm = managed_helm().await;
    use_helm(core, &helm, root);
    core.helm_repo_add(HelmRepoAdd {
        name: "prometheus-community".to_owned(),
        url: CHART_REPO.to_owned(),
        username: None,
        password: None,
    })
    .await
    .unwrap();
    let request = HelmInstallRequest {
        namespace: RELEASE_NAMESPACE.to_owned(),
        release_name: Some(RELEASE.to_owned()),
        chart: ChartRef {
            repo: "prometheus-community".to_owned(),
            chart: "prometheus".to_owned(),
            version: CHART_VERSION.to_owned(),
        },
        values: VALUES.to_owned(),
        create_namespace: true,
        wait: true,
    };
    let (tx, rx) = mpsc::channel(64);
    core.helm_install_start(id, &request, tx).await.unwrap();
    let (text, last) = session_output(rx).await;
    assert!(
        matches!(last, SessionEvent::Exited { code: Some(0) }),
        "{last:?}\n{text}"
    );
}

/// Deployment `web`: two pods asking for 50m and 32 MiB each, limited to 200m and 64 MiB.
async fn create_web(client: &Client, namespace: &str) {
    let deployment: Deployment = serde_json::from_value(json!({
        "metadata": { "name": "web" },
        "spec": {
            "replicas": 2,
            "selector": { "matchLabels": { "app": "web" } },
            "template": {
                "metadata": { "labels": { "app": "web" } },
                "spec": {
                    "containers": [{
                        "name": "web",
                        "image": TEST_IMAGE,
                        "command": ["/bin/sh", "-c", WEB_SCRIPT],
                        "resources": {
                            "requests": { "cpu": "50m", "memory": "32Mi" },
                            "limits": { "cpu": "200m", "memory": "64Mi" },
                        },
                        "volumeMounts": [{ "name": "scratch", "mountPath": "/scratch" }],
                    }],
                    "volumes": [{ "name": "scratch", "emptyDir": {} }],
                },
            },
        },
    }))
    .unwrap();
    Api::<Deployment>::namespaced(client.clone(), namespace)
        .create(&PostParams::default(), &deployment)
        .await
        .unwrap();
}

/// The names of the two web pods once both run, sorted.
async fn running_web_pods(client: &Client, namespace: &str) -> Vec<String> {
    let pods: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let started = Instant::now();
    loop {
        let list = pods
            .list(&ListParams::default().labels("app=web"))
            .await
            .unwrap();
        let mut running: Vec<String> = list
            .items
            .iter()
            .filter(|pod| {
                pod.status
                    .as_ref()
                    .and_then(|status| status.phase.as_deref())
                    == Some("Running")
            })
            .filter_map(|pod| pod.metadata.name.clone())
            .collect();
        if running.len() == 2 {
            running.sort();
            return running;
        }
        assert!(started.elapsed() < DATA_WAIT, "the web pods did not start");
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

/// Asks every 10 s until `done` holds, and returns that answer.
async fn answer_when(
    core: &AppCore,
    id: &ClusterId,
    target: &MetricsTarget,
    done: impl Fn(&MetricsResult) -> bool,
) -> MetricsResult {
    let started = Instant::now();
    loop {
        let result = core
            .metrics_query(id, target, MetricsRange::OneHour)
            .await
            .unwrap();
        if done(&result) {
            return result;
        }
        assert!(
            started.elapsed() < DATA_WAIT,
            "{target:?} never answered as expected: {result:?}"
        );
        tokio::time::sleep(Duration::from_secs(10)).await;
    }
}

/// Every metric in `present` has data, and exactly `missing` has none.
fn has(result: &MetricsResult, present: &[MetricName], missing: &[MetricName]) -> bool {
    present.iter().all(|name| result.series.contains_key(name)) && result.missing == missing
}

fn last(result: &MetricsResult, name: MetricName) -> Option<f64> {
    result.series.get(&name)?.last().map(|(_, value)| *value)
}

/// Asks every 10 s until `done` holds, and returns that snapshot.
async fn usage_when(
    core: &AppCore,
    id: &ClusterId,
    of: UsageOf,
    namespace: Option<&str>,
    done: impl Fn(&UsageSnapshot) -> bool,
) -> UsageSnapshot {
    let started = Instant::now();
    loop {
        let snapshot = core.metrics_usage(id, of, namespace).await.unwrap();
        if done(&snapshot) {
            return snapshot;
        }
        assert!(started.elapsed() < DATA_WAIT, "{snapshot:?}");
        tokio::time::sleep(Duration::from_secs(10)).await;
    }
}

fn names(snapshot: &UsageSnapshot) -> Vec<&str> {
    snapshot
        .items
        .iter()
        .map(|item| item.name.as_str())
        .collect()
}

#[tokio::test]
#[ignore = "needs make test-metrics: Prometheus and metrics-server on the skopos-e2e kind cluster"]
async fn metrics_server_measures_both_nodes_and_the_test_pods() {
    let (core, id, _root) = connected_kind().await;
    let nodes = usage_when(&core, &id, UsageOf::Nodes, None, |snapshot| {
        names(snapshot) == NODES
            && snapshot
                .items
                .iter()
                .all(|node| node.cpu_cores > 0.0 && node.memory_bytes > 0.0)
    })
    .await;
    assert!(nodes.items.iter().all(|node| node.namespace.is_none()));
    nodes.timestamp.parse::<Timestamp>().unwrap();

    let client = core.cluster_client(&id).unwrap();
    in_namespace(&client, USAGE_NAMESPACE, async {
        create_web(&client, USAGE_NAMESPACE).await;
        let pods = running_web_pods(&client, USAGE_NAMESPACE).await;
        let snapshot = usage_when(
            &core,
            &id,
            UsageOf::Pods,
            Some(USAGE_NAMESPACE),
            |snapshot| names(snapshot) == pods,
        )
        .await;
        for pod in &snapshot.items {
            assert_eq!(pod.namespace.as_deref(), Some(USAGE_NAMESPACE));
            assert!(pod.memory_bytes > 0.0, "{pod:?}");
        }
    })
    .await;
}

#[tokio::test]
#[ignore = "needs make test-metrics: Prometheus and metrics-server on the skopos-e2e kind cluster"]
async fn prometheus_from_the_community_chart_answers_every_target() {
    use MetricName::*;
    let (core, id, root) = connected_kind().await;
    install_prometheus(&core, &id, root.path()).await;
    assert_eq!(
        core.metrics_provider(&id, true).await.unwrap(),
        MetricsProvider::Prometheus {
            namespace: RELEASE_NAMESPACE.to_owned(),
            service: format!("{RELEASE}-server"),
            port: 80,
            chosen_by: PrometheusChoice::CommunityChart,
        }
    );

    let client = core.cluster_client(&id).unwrap();
    in_namespace(&client, QUERY_NAMESPACE, async {
        create_web(&client, QUERY_NAMESPACE).await;
        let pods = running_web_pods(&client, QUERY_NAMESPACE).await;

        let machine = [
            CpuUsage,
            CpuRequests,
            CpuLimits,
            CpuAllocatable,
            CpuCapacity,
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
        ];
        answer_when(&core, &id, &MetricsTarget::Cluster, |r| {
            has(r, &machine, &[])
        })
        .await;
        let worker = MetricsTarget::Node {
            name: NODES[1].to_owned(),
        };
        answer_when(&core, &id, &worker, |r| has(r, &machine, &[])).await;

        // kind runs containerd, which reports container_fs_usage_bytes per node only.
        let pod_metrics = [
            CpuUsage,
            CpuRequests,
            CpuLimits,
            MemoryUsage,
            MemoryRequests,
            MemoryLimits,
            NetworkReceive,
            NetworkTransmit,
            FsReads,
            FsWrites,
        ];
        let web = MetricsTarget::Workload {
            namespace: QUERY_NAMESPACE.to_owned(),
            name: "web".to_owned(),
            workload_kind: WorkloadKind::Deployment,
        };
        // Both pods count: 2 × 50m requested, 2 × 64 MiB allowed.
        answer_when(&core, &id, &web, |r| {
            has(r, &pod_metrics, &[FsUsage])
                && last(r, CpuRequests) == Some(0.1)
                && last(r, MemoryLimits) == Some(134_217_728.0)
        })
        .await;
        let pod = MetricsTarget::Pod {
            namespace: QUERY_NAMESPACE.to_owned(),
            name: pods[0].clone(),
        };
        answer_when(&core, &id, &pod, |r| {
            has(r, &pod_metrics, &[FsUsage]) && last(r, CpuLimits) == Some(0.2)
        })
        .await;

        // kind's kubelets publish no volume stats: a claim has no data, and the call answers.
        let claim = MetricsTarget::Pvc {
            namespace: QUERY_NAMESPACE.to_owned(),
            name: "data".to_owned(),
        };
        answer_when(&core, &id, &claim, |r| {
            has(r, &[], &[DiskUsage, DiskCapacity])
        })
        .await;
    })
    .await;
}
