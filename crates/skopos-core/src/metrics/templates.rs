//! PromQL for each target (spec §5.4): our own templates over the standard names of cAdvisor,
//! kube-state-metrics and node exporter.

use super::MetricName::{self, *};
use super::MetricsRange;

/// A pod counts while it is Pending or Running; completed pods keep their series.
const ACTIVE: &str = r#"max by (namespace, pod) (kube_pod_status_phase{phase=~"Pending|Running"})"#;
const BUSY_CPU: &str = r#"mode!~"idle|iowait|steal""#;
/// Real containers. A pod's own cgroup and its sandbox carry no container name.
const CONTAINERS: &str = r#"container!="", container!="POD""#;
/// What RE2 reads as more than a literal character.
const REGEX_META: &str = r"\.+*?()|[]{}^$";

/// The span of a range query, in unix seconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Window {
    pub(crate) start: i64,
    pub(crate) end: i64,
    pub(crate) step: i64,
}

impl MetricsRange {
    /// The length in seconds, and the step between points.
    fn seconds_and_step(self) -> (i64, i64) {
        match self {
            Self::OneHour => (3_600, 60),
            Self::SixHours => (21_600, 300),
            Self::OneDay => (86_400, 900),
            Self::SevenDays => (604_800, 3_600),
        }
    }

    /// The range ending at the last whole step before `now`, so a query repeated within one
    /// step asks for the same points.
    pub(crate) fn window(self, now: i64) -> Window {
        let (seconds, step) = self.seconds_and_step();
        let end = now - now.rem_euclid(step);
        Window {
            start: end - seconds,
            end,
            step,
        }
    }
}

/// `max(2m, step)`.
pub(crate) fn rate_window(step: i64) -> String {
    format!("{}s", step.max(120))
}

/// A PromQL string literal.
pub(crate) fn quote(text: &str) -> String {
    let mut quoted = String::with_capacity(text.len() + 2);
    quoted.push('"');
    for c in text.chars() {
        match c {
            '\\' => quoted.push_str(r"\\"),
            '"' => quoted.push_str("\\\""),
            '\n' => quoted.push_str(r"\n"),
            c => quoted.push(c),
        }
    }
    quoted.push('"');
    quoted
}

/// A regular expression that matches `text` and nothing else.
pub(crate) fn escape_regex(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for c in text.chars() {
        if REGEX_META.contains(c) {
            escaped.push('\\');
        }
        escaped.push(c);
    }
    escaped
}

/// What a target covers, with a workload's pods already listed.
pub(crate) enum Scope<'a> {
    Cluster,
    Node(&'a str),
    /// One pod, or a workload's pods. Never empty.
    Pods {
        namespace: &'a str,
        pods: &'a [String],
    },
    Pvc {
        namespace: &'a str,
        name: &'a str,
    },
}

/// The target's metrics in the contract's order, each with its query.
pub(crate) fn queries(scope: &Scope<'_>, step: i64) -> Vec<(MetricName, String)> {
    let window = rate_window(step);
    match scope {
        Scope::Cluster => machines(None, &window),
        Scope::Node(name) => machines(Some(*name), &window),
        Scope::Pods { namespace, pods } => pods_of(namespace, pods, &window),
        Scope::Pvc { namespace, name } => volume(namespace, name),
    }
}

fn selector(metric: &str, matchers: &[String]) -> String {
    if matchers.is_empty() {
        metric.to_owned()
    } else {
        format!("{metric}{{{}}}", matchers.join(", "))
    }
}

/// The sum over pods that are Pending or Running.
fn of_active(series: &str) -> String {
    format!("sum({series} * on(namespace, pod) group_left() {ACTIVE})")
}

/// A node exporter expression summed over the cluster, or over the one node whose
/// `node_uname_info` names it, whatever the scrape put in `instance`.
fn on_node(expr: &str, node: Option<&str>) -> String {
    match node {
        None => format!("sum({expr})"),
        Some(node) => format!(
            "sum(({expr}) * on(instance) group_left() max by (instance) (node_uname_info{{nodename={}}}))",
            quote(node)
        ),
    }
}

/// Each node's root filesystem: `/`, or `/var` on a node without `/` among its mounts, as on
/// kind's nodes.
fn root_disk(used: bool) -> String {
    let mount = |mountpoint: &str| {
        let matcher = format!("mountpoint={}", quote(mountpoint));
        let size = format!("node_filesystem_size_bytes{{{matcher}}}");
        if used {
            format!("{size} - node_filesystem_avail_bytes{{{matcher}}}")
        } else {
            size
        }
    };
    format!(
        "max by (instance) ({}) or max by (instance) ({})",
        mount("/"),
        mount("/var")
    )
}

/// The cluster's nodes, or one node.
fn machines(node: Option<&str>, window: &str) -> Vec<(MetricName, String)> {
    let state = |metric: &str, resource: Option<&str>| {
        let mut matchers = Vec::new();
        if let Some(resource) = resource {
            matchers.push(format!("resource={}", quote(resource)));
        }
        if let Some(node) = node {
            matchers.push(format!("node={}", quote(node)));
        }
        selector(metric, &matchers)
    };
    let requests = |resource: &str| {
        of_active(&state(
            "kube_pod_container_resource_requests",
            Some(resource),
        ))
    };
    let limits =
        |resource: &str| of_active(&state("kube_pod_container_resource_limits", Some(resource)));
    let allocatable = |resource: &str| {
        format!(
            "sum({})",
            state("kube_node_status_allocatable", Some(resource))
        )
    };
    let capacity = |resource: &str| {
        format!(
            "sum({})",
            state("kube_node_status_capacity", Some(resource))
        )
    };
    let cpu = format!("rate(node_cpu_seconds_total{{{BUSY_CPU}}}[{window}])");
    vec![
        (CpuUsage, on_node(&cpu, node)),
        (CpuRequests, requests("cpu")),
        (CpuLimits, limits("cpu")),
        (CpuAllocatable, allocatable("cpu")),
        (CpuCapacity, capacity("cpu")),
        (
            MemoryUsage,
            on_node(
                "node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes",
                node,
            ),
        ),
        (MemoryRequests, requests("memory")),
        (MemoryLimits, limits("memory")),
        (MemoryAllocatable, allocatable("memory")),
        (MemoryCapacity, capacity("memory")),
        (PodUsage, of_active(&state("kube_pod_info", None))),
        (PodAllocatable, allocatable("pods")),
        (PodCapacity, capacity("pods")),
        (DiskUsage, on_node(&root_disk(true), node)),
        (DiskCapacity, on_node(&root_disk(false), node)),
    ]
}

/// One pod, or a workload's pods.
fn pods_of(namespace: &str, pods: &[String], window: &str) -> Vec<(MetricName, String)> {
    let pod = match pods {
        [one] => format!("pod={}", quote(one)),
        many => {
            let names: Vec<String> = many.iter().map(String::as_str).map(escape_regex).collect();
            format!("pod=~{}", quote(&format!("^(?:{})$", names.join("|"))))
        }
    };
    let all = format!("namespace={}, {pod}", quote(namespace));
    let containers = format!("{all}, {CONTAINERS}");
    let rate =
        |metric: &str, matchers: &str| format!("sum(rate({metric}{{{matchers}}}[{window}]))");
    let resource = |metric: &str, resource: &str| {
        of_active(&format!("{metric}{{{all}, resource={}}}", quote(resource)))
    };
    vec![
        (
            CpuUsage,
            rate("container_cpu_usage_seconds_total", &containers),
        ),
        (
            CpuRequests,
            resource("kube_pod_container_resource_requests", "cpu"),
        ),
        (
            CpuLimits,
            resource("kube_pod_container_resource_limits", "cpu"),
        ),
        (
            MemoryUsage,
            format!("sum(container_memory_working_set_bytes{{{containers}}})"),
        ),
        (
            MemoryRequests,
            resource("kube_pod_container_resource_requests", "memory"),
        ),
        (
            MemoryLimits,
            resource("kube_pod_container_resource_limits", "memory"),
        ),
        // Only the pod's sandbox counts network traffic, and it has no container name.
        (
            NetworkReceive,
            rate("container_network_receive_bytes_total", &all),
        ),
        (
            NetworkTransmit,
            rate("container_network_transmit_bytes_total", &all),
        ),
        (FsReads, rate("container_fs_reads_bytes_total", &containers)),
        (
            FsWrites,
            rate("container_fs_writes_bytes_total", &containers),
        ),
        (
            FsUsage,
            format!("sum(container_fs_usage_bytes{{{containers}}})"),
        ),
    ]
}

/// A PersistentVolumeClaim, from the kubelet of each node that mounts it. A volume mounted on
/// two nodes is reported twice, so the larger value counts.
fn volume(namespace: &str, name: &str) -> Vec<(MetricName, String)> {
    let matchers = format!(
        "namespace={}, persistentvolumeclaim={}",
        quote(namespace),
        quote(name)
    );
    vec![
        (
            DiskUsage,
            format!("max(kubelet_volume_stats_used_bytes{{{matchers}}})"),
        ),
        (
            DiskCapacity,
            format!("max(kubelet_volume_stats_capacity_bytes{{{matchers}}})"),
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query(scope: &Scope<'_>, step: i64, name: MetricName) -> String {
        queries(scope, step)
            .into_iter()
            .find(|(metric, _)| *metric == name)
            .map(|(_, query)| query)
            .unwrap()
    }

    fn names(scope: Scope<'_>) -> Vec<MetricName> {
        queries(&scope, 60)
            .into_iter()
            .map(|(name, _)| name)
            .collect()
    }

    #[test]
    fn windows_end_on_a_whole_step_and_span_the_range() {
        let window = |start, end, step| Window { start, end, step };
        assert_eq!(
            MetricsRange::OneHour.window(1_000_030),
            window(996_420, 1_000_020, 60)
        );
        assert_eq!(
            MetricsRange::SixHours.window(1_000_030),
            window(978_300, 999_900, 300)
        );
        assert_eq!(
            MetricsRange::OneDay.window(1_000_030),
            window(913_500, 999_900, 900)
        );
        assert_eq!(
            MetricsRange::SevenDays.window(1_000_030),
            window(392_400, 997_200, 3_600)
        );
        // Asked again within the same step, the same points.
        assert_eq!(
            MetricsRange::OneHour.window(1_000_079),
            MetricsRange::OneHour.window(1_000_020)
        );
    }

    #[test]
    fn rate_windows_are_at_least_two_minutes() {
        assert_eq!(rate_window(60), "120s");
        assert_eq!(rate_window(300), "300s");
        assert_eq!(rate_window(3_600), "3600s");
    }

    #[test]
    fn names_are_quoted_and_escaped() {
        assert_eq!(quote("web"), r#""web""#);
        assert_eq!(quote(r#"a"b\c"#), r#""a\"b\\c""#);
        assert_eq!(
            escape_regex("ip-10-0-0-1.ec2.internal"),
            r"ip-10-0-0-1\.ec2\.internal"
        );
        assert_eq!(
            escape_regex("a+b(c)|[d]{e}^$*?"),
            r"a\+b\(c\)\|\[d\]\{e\}\^\$\*\?"
        );
        let node = query(&Scope::Node("ip-10.internal"), 60, MetricName::PodCapacity);
        assert!(node.contains(r#"node="ip-10.internal""#), "{node}");
        let pods = ["a.b".to_owned(), "c".to_owned()];
        let cpu = query(
            &Scope::Pods {
                namespace: "shop",
                pods: &pods,
            },
            60,
            MetricName::CpuUsage,
        );
        assert!(cpu.contains(r#"pod=~"^(?:a\\.b|c)$""#), "{cpu}");
    }

    #[test]
    fn each_target_asks_for_the_contract_metrics() {
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
        assert_eq!(names(Scope::Cluster), machine);
        assert_eq!(names(Scope::Node("n")), machine);
        let pods = ["p".to_owned()];
        assert_eq!(
            names(Scope::Pods {
                namespace: "ns",
                pods: &pods
            }),
            [
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
                FsUsage,
            ]
        );
        assert_eq!(
            names(Scope::Pvc {
                namespace: "ns",
                name: "data"
            }),
            [DiskUsage, DiskCapacity]
        );
    }

    #[test]
    fn the_cluster_sums_every_node() {
        let cluster = |name| query(&Scope::Cluster, 60, name);
        assert_eq!(
            cluster(CpuUsage),
            r#"sum(rate(node_cpu_seconds_total{mode!~"idle|iowait|steal"}[120s]))"#
        );
        assert_eq!(
            cluster(MemoryUsage),
            "sum(node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes)"
        );
        assert_eq!(
            cluster(DiskCapacity),
            r#"sum(max by (instance) (node_filesystem_size_bytes{mountpoint="/"}) or max by (instance) (node_filesystem_size_bytes{mountpoint="/var"}))"#
        );
        assert_eq!(
            cluster(DiskUsage),
            r#"sum(max by (instance) (node_filesystem_size_bytes{mountpoint="/"} - node_filesystem_avail_bytes{mountpoint="/"}) or max by (instance) (node_filesystem_size_bytes{mountpoint="/var"} - node_filesystem_avail_bytes{mountpoint="/var"}))"#
        );
        assert_eq!(
            cluster(PodUsage),
            r#"sum(kube_pod_info * on(namespace, pod) group_left() max by (namespace, pod) (kube_pod_status_phase{phase=~"Pending|Running"}))"#
        );
        assert_eq!(
            cluster(MemoryLimits),
            r#"sum(kube_pod_container_resource_limits{resource="memory"} * on(namespace, pod) group_left() max by (namespace, pod) (kube_pod_status_phase{phase=~"Pending|Running"}))"#
        );
        assert_eq!(
            cluster(CpuAllocatable),
            r#"sum(kube_node_status_allocatable{resource="cpu"})"#
        );
        assert_eq!(
            cluster(PodCapacity),
            r#"sum(kube_node_status_capacity{resource="pods"})"#
        );
    }

    #[test]
    fn a_node_joins_node_exporter_by_instance_and_filters_kube_state_metrics_by_node() {
        let node = |name| query(&Scope::Node("worker"), 60, name);
        assert_eq!(
            node(CpuUsage),
            r#"sum((rate(node_cpu_seconds_total{mode!~"idle|iowait|steal"}[120s])) * on(instance) group_left() max by (instance) (node_uname_info{nodename="worker"}))"#
        );
        assert_eq!(
            node(DiskCapacity),
            r#"sum((max by (instance) (node_filesystem_size_bytes{mountpoint="/"}) or max by (instance) (node_filesystem_size_bytes{mountpoint="/var"})) * on(instance) group_left() max by (instance) (node_uname_info{nodename="worker"}))"#
        );
        assert_eq!(
            node(CpuRequests),
            r#"sum(kube_pod_container_resource_requests{resource="cpu", node="worker"} * on(namespace, pod) group_left() max by (namespace, pod) (kube_pod_status_phase{phase=~"Pending|Running"}))"#
        );
        assert_eq!(
            node(PodUsage),
            r#"sum(kube_pod_info{node="worker"} * on(namespace, pod) group_left() max by (namespace, pod) (kube_pod_status_phase{phase=~"Pending|Running"}))"#
        );
        assert_eq!(
            node(MemoryAllocatable),
            r#"sum(kube_node_status_allocatable{resource="memory", node="worker"})"#
        );
    }

    #[test]
    fn pods_count_containers_only_except_for_network() {
        let pods = ["web-1".to_owned()];
        let pod = |name| {
            query(
                &Scope::Pods {
                    namespace: "shop",
                    pods: &pods,
                },
                300,
                name,
            )
        };
        assert_eq!(
            pod(CpuUsage),
            r#"sum(rate(container_cpu_usage_seconds_total{namespace="shop", pod="web-1", container!="", container!="POD"}[300s]))"#
        );
        assert_eq!(
            pod(MemoryUsage),
            r#"sum(container_memory_working_set_bytes{namespace="shop", pod="web-1", container!="", container!="POD"})"#
        );
        assert_eq!(
            pod(CpuLimits),
            r#"sum(kube_pod_container_resource_limits{namespace="shop", pod="web-1", resource="cpu"} * on(namespace, pod) group_left() max by (namespace, pod) (kube_pod_status_phase{phase=~"Pending|Running"}))"#
        );
        assert_eq!(
            pod(NetworkTransmit),
            r#"sum(rate(container_network_transmit_bytes_total{namespace="shop", pod="web-1"}[300s]))"#
        );
        assert_eq!(
            pod(FsWrites),
            r#"sum(rate(container_fs_writes_bytes_total{namespace="shop", pod="web-1", container!="", container!="POD"}[300s]))"#
        );
        assert_eq!(
            pod(FsUsage),
            r#"sum(container_fs_usage_bytes{namespace="shop", pod="web-1", container!="", container!="POD"})"#
        );
    }

    #[test]
    fn a_workload_matches_its_pods_by_an_anchored_alternation() {
        let pods = ["web-7d9f-abcde".to_owned(), "web-7d9f-fghij".to_owned()];
        let memory = query(
            &Scope::Pods {
                namespace: "shop",
                pods: &pods,
            },
            60,
            MemoryRequests,
        );
        assert_eq!(
            memory,
            r#"sum(kube_pod_container_resource_requests{namespace="shop", pod=~"^(?:web-7d9f-abcde|web-7d9f-fghij)$", resource="memory"} * on(namespace, pod) group_left() max by (namespace, pod) (kube_pod_status_phase{phase=~"Pending|Running"}))"#
        );
    }

    #[test]
    fn a_pvc_reads_the_kubelet_volume_stats() {
        let pvc = |name| {
            query(
                &Scope::Pvc {
                    namespace: "shop",
                    name: "data",
                },
                60,
                name,
            )
        };
        assert_eq!(
            pvc(DiskUsage),
            r#"max(kubelet_volume_stats_used_bytes{namespace="shop", persistentvolumeclaim="data"})"#
        );
        assert_eq!(
            pvc(DiskCapacity),
            r#"max(kubelet_volume_stats_capacity_bytes{namespace="shop", persistentvolumeclaim="data"})"#
        );
    }
}
