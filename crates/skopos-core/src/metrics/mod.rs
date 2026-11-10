//! Metrics (F16): the provider setting, detection of Prometheus or metrics-server with a cache
//! per cluster, and the queries the interface repeats on its own timer (spec §5.4).

mod detect;
pub(crate) mod prometheus;
mod query;
pub(crate) mod templates;
pub(crate) use detect::Metrics;
pub use detect::MetricsLimits;
mod usage;
pub(crate) use usage::METRICS_API;
pub use usage::{UsageItem, UsageOf, UsageSnapshot};

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::CoreResult;
use crate::resources::invalid;

/// `ClusterSettings.metricsProvider`: detect, pin one Prometheus Service, use metrics-server
/// alone, or show no metrics.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum MetricsProviderSetting {
    #[default]
    Auto,
    Prometheus {
        namespace: String,
        service: String,
        port: u16,
        scheme: Option<PrometheusScheme>,
        /// Where Prometheus serves its API when it runs under a path, such as `/prometheus`.
        path_prefix: Option<String>,
    },
    MetricsServer,
    /// `none` on the wire. A variant named `None` would read as `Option::None` in patterns.
    #[serde(rename = "none")]
    Off,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum PrometheusScheme {
    Http,
    Https,
}

impl MetricsProviderSetting {
    /// The setting as it is saved. A pinned Service has its names checked and its path
    /// prefix trimmed to `/a/b` form, or `None`. Anything else is `InvalidInput`.
    pub(crate) fn normalized(self) -> CoreResult<Self> {
        let Self::Prometheus {
            namespace,
            service,
            port,
            scheme,
            path_prefix,
        } = self
        else {
            return Ok(self);
        };
        let namespace = namespace.trim().to_owned();
        let service = service.trim().to_owned();
        if !is_dns_label(&namespace) {
            return Err(invalid(
                "the Prometheus namespace must be a lowercase RFC 1123 label",
            ));
        }
        if !is_dns_label(&service) {
            return Err(invalid(
                "the Prometheus service must be a lowercase RFC 1123 label",
            ));
        }
        if port == 0 {
            return Err(invalid("the Prometheus port must be between 1 and 65535"));
        }
        Ok(Self::Prometheus {
            namespace,
            service,
            port,
            scheme,
            path_prefix: path_prefix_of(path_prefix)?,
        })
    }
}

/// Lowercase letters, digits and `-`, 1 to 63 characters, with a letter or digit at each
/// end: what Kubernetes allows for namespace and Service names.
fn is_dns_label(name: &str) -> bool {
    (1..=63).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !name.starts_with('-')
        && !name.ends_with('-')
}

fn path_prefix_of(prefix: Option<String>) -> CoreResult<Option<String>> {
    let Some(prefix) = prefix else {
        return Ok(None);
    };
    let prefix = prefix.trim().trim_end_matches('/');
    if prefix.is_empty() {
        return Ok(None);
    }
    // Only characters that need no escaping in a URL path, so the request always builds.
    let unusable = !prefix.starts_with('/')
        || !prefix
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-._~/".contains(c))
        || prefix
            .split('/')
            .any(|segment| segment == "." || segment == "..");
    if unusable {
        return Err(invalid(
            "the Prometheus path prefix must be a path such as /prometheus",
        ));
    }
    Ok(Some(prefix.to_owned()))
}

/// What `metrics_query` reads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum MetricsTarget {
    Cluster,
    Node {
        name: String,
    },
    Pod {
        namespace: String,
        name: String,
    },
    Workload {
        namespace: String,
        name: String,
        workload_kind: WorkloadKind,
    },
    Pvc {
        namespace: String,
        name: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum WorkloadKind {
    Deployment,
    StatefulSet,
    DaemonSet,
    ReplicaSet,
    Job,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum MetricsRange {
    #[serde(rename = "1h")]
    OneHour,
    #[serde(rename = "6h")]
    SixHours,
    #[serde(rename = "24h")]
    OneDay,
    #[serde(rename = "7d")]
    SevenDays,
}

/// Units: CPU in cores; memory and disk in bytes; network and filesystem reads and writes in
/// bytes per second; pods as counts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum MetricName {
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
    NetworkReceive,
    NetworkTransmit,
    FsReads,
    FsWrites,
    FsUsage,
}

/// Points are `[unix seconds, value]`.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MetricsResult {
    /// Unix seconds.
    #[ts(type = "number")]
    pub start: i64,
    #[ts(type = "number")]
    pub end: i64,
    /// Seconds between points.
    #[ts(type = "number")]
    pub step: i64,
    pub series: BTreeMap<MetricName, Vec<(f64, f64)>>,
    /// Asked for this target, but no data: the query failed or returned no samples.
    pub missing: Vec<MetricName>,
}

/// Where this cluster's metrics come from, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum MetricsProvider {
    Prometheus {
        namespace: String,
        service: String,
        port: u16,
        chosen_by: PrometheusChoice,
    },
    MetricsServer {
        chosen_by: MetricsServerChoice,
    },
    #[serde(rename = "none")]
    Off {
        chosen_by: NoProviderChoice,
    },
}

/// The setting, or the detection tier that found Prometheus, in probe order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum PrometheusChoice {
    Setting,
    KubePrometheusStack,
    Operator,
    CommunityChart,
    Label,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum MetricsServerChoice {
    Setting,
    /// Detection found no Prometheus, and the cluster serves metrics.k8s.io.
    Fallback,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum NoProviderChoice {
    Setting,
    NothingFound,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::error::ErrorCode;
    use crate::prefs::ClusterSettings;

    use super::*;

    fn pinned(
        namespace: &str,
        service: &str,
        port: u16,
        prefix: Option<&str>,
    ) -> MetricsProviderSetting {
        MetricsProviderSetting::Prometheus {
            namespace: namespace.to_owned(),
            service: service.to_owned(),
            port,
            scheme: None,
            path_prefix: prefix.map(str::to_owned),
        }
    }

    #[test]
    fn settings_targets_and_results_use_the_contract_shape() {
        let saved_before: ClusterSettings =
            serde_json::from_value(json!({ "displayName": "prod" })).unwrap();
        assert_eq!(saved_before.metrics_provider, MetricsProviderSetting::Auto);
        assert_eq!(
            serde_json::to_value(pinned("monitoring", "prom", 9090, Some("/prom"))).unwrap(),
            json!({
                "kind": "prometheus",
                "namespace": "monitoring",
                "service": "prom",
                "port": 9090,
                "scheme": null,
                "pathPrefix": "/prom",
            })
        );
        let https: MetricsProviderSetting = serde_json::from_value(json!({
            "kind": "prometheus",
            "namespace": "m",
            "service": "p",
            "port": 443,
            "scheme": "https",
            "pathPrefix": null,
        }))
        .unwrap();
        assert!(matches!(
            https,
            MetricsProviderSetting::Prometheus {
                scheme: Some(PrometheusScheme::Https),
                ..
            }
        ));
        assert_eq!(
            serde_json::to_value(MetricsProviderSetting::MetricsServer).unwrap(),
            json!({ "kind": "metricsServer" })
        );
        assert_eq!(
            serde_json::to_value(MetricsProviderSetting::Off).unwrap(),
            json!({ "kind": "none" })
        );

        let target: MetricsTarget = serde_json::from_value(json!({
            "kind": "workload",
            "namespace": "shop",
            "name": "web",
            "workloadKind": "StatefulSet",
        }))
        .unwrap();
        assert_eq!(
            target,
            MetricsTarget::Workload {
                namespace: "shop".to_owned(),
                name: "web".to_owned(),
                workload_kind: WorkloadKind::StatefulSet,
            }
        );
        let ranges: Vec<MetricsRange> =
            serde_json::from_value(json!(["1h", "6h", "24h", "7d"])).unwrap();
        assert_eq!(
            ranges,
            [
                MetricsRange::OneHour,
                MetricsRange::SixHours,
                MetricsRange::OneDay,
                MetricsRange::SevenDays,
            ]
        );

        let result = MetricsResult {
            start: 0,
            end: 60,
            step: 60,
            series: BTreeMap::from([(MetricName::CpuUsage, vec![(60.0, 0.5)])]),
            missing: vec![MetricName::FsUsage],
        };
        assert_eq!(
            serde_json::to_value(&result).unwrap(),
            json!({
                "start": 0,
                "end": 60,
                "step": 60,
                "series": { "cpuUsage": [[60.0, 0.5]] },
                "missing": ["fsUsage"],
            })
        );
    }

    #[test]
    fn a_pinned_prometheus_is_tidied_or_refused() {
        assert_eq!(
            pinned(" monitoring ", " prom ", 9090, Some(" /prom/ "))
                .normalized()
                .unwrap(),
            pinned("monitoring", "prom", 9090, Some("/prom"))
        );
        assert_eq!(
            pinned("monitoring", "prom", 9090, Some(" / "))
                .normalized()
                .unwrap(),
            pinned("monitoring", "prom", 9090, None)
        );
        assert_eq!(
            MetricsProviderSetting::Off.normalized().unwrap(),
            MetricsProviderSetting::Off
        );
        let long_name = "p".repeat(64);
        let refused = [
            pinned("", "prom", 9090, None),
            pinned("Monitoring", "prom", 9090, None),
            pinned("monitoring", "prom:80", 9090, None),
            pinned("monitoring", "a/b", 9090, None),
            pinned("monitoring", "-prom", 9090, None),
            pinned("monitoring", &long_name, 9090, None),
            pinned("monitoring", "prom", 0, None),
            pinned("monitoring", "prom", 9090, Some("prom")),
            pinned("monitoring", "prom", 9090, Some("/a/../b")),
            pinned("monitoring", "prom", 9090, Some("/a?b=1")),
            pinned("monitoring", "prom", 9090, Some("/a%2fb")),
            pinned("monitoring", "prom", 9090, Some("/a b")),
            pinned("monitoring", "prom", 9090, Some("/é")),
        ];
        for setting in refused {
            let err = setting.clone().normalized().unwrap_err();
            assert_eq!(err.code, ErrorCode::InvalidInput, "{setting:?}");
        }
    }
}
