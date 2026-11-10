//! metrics.k8s.io snapshots (spec §5.4, `metrics_usage`): what metrics-server measured last,
//! per node or per pod.

use http::Request;
use k8s_openapi::jiff::Timestamp;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::app_core::AppCore;
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::kubeconfig::ClusterId;
use crate::resources::{invalid, is_path_segment};

/// metrics-server's API group and version.
pub(crate) const METRICS_API: &str = "/apis/metrics.k8s.io/v1beta1";

const BINARY_SUFFIXES: [&str; 6] = ["Ki", "Mi", "Gi", "Ti", "Pi", "Ei"];
const DECIMAL_SUFFIXES: [(&str, i32); 10] = [
    ("", 0),
    ("n", -9),
    ("u", -6),
    ("m", -3),
    ("k", 3),
    ("M", 6),
    ("G", 9),
    ("T", 12),
    ("P", 15),
    ("E", 18),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum UsageOf {
    Nodes,
    Pods,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UsageItem {
    /// `null` for a node.
    pub namespace: Option<String>,
    pub name: String,
    pub cpu_cores: f64,
    pub memory_bytes: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UsageSnapshot {
    /// RFC 3339: when the newest item was measured, or now when there is none.
    pub timestamp: String,
    /// Sorted by namespace, then name.
    pub items: Vec<UsageItem>,
}

/// A Kubernetes quantity such as `250m`, `1.5Gi` or `12e3`, as a plain number. A decimal
/// scale below one divides, so `250m` is exactly `0.25`.
pub(crate) fn parse_quantity(text: &str) -> Option<f64> {
    let (sign, rest) = match text.as_bytes().first()? {
        b'-' => (-1.0, &text[1..]),
        b'+' => (1.0, &text[1..]),
        _ => (1.0, text),
    };
    let number_end = rest
        .find(|c: char| !c.is_ascii_digit() && c != '.')
        .unwrap_or(rest.len());
    let (number, suffix) = rest.split_at(number_end);
    if number.matches('.').count() > 1 || !number.bytes().any(|b| b.is_ascii_digit()) {
        return None;
    }
    let number: f64 = number.parse().ok()?;
    let scaled = if let Some(power) = BINARY_SUFFIXES.iter().position(|s| *s == suffix) {
        number * 2f64.powi(10 * (power as i32 + 1))
    } else {
        let exponent = match DECIMAL_SUFFIXES.iter().find(|(s, _)| *s == suffix) {
            Some((_, exponent)) => *exponent,
            None => suffix.strip_prefix(['e', 'E'])?.parse::<i32>().ok()?,
        };
        if exponent < 0 {
            number / 10f64.powi(exponent.saturating_neg())
        } else {
            number * 10f64.powi(exponent)
        }
    };
    let value = sign * scaled;
    value.is_finite().then_some(value)
}

impl AppCore {
    /// What metrics-server measured last for every node, or for every pod (in one namespace,
    /// or all). Nodes ignore `namespace`.
    pub async fn metrics_usage(
        &self,
        id: &ClusterId,
        of: UsageOf,
        namespace: Option<&str>,
    ) -> CoreResult<UsageSnapshot> {
        let path = match (of, namespace) {
            (UsageOf::Nodes, _) => format!("{METRICS_API}/nodes"),
            (UsageOf::Pods, None) => format!("{METRICS_API}/pods"),
            (UsageOf::Pods, Some(namespace)) => {
                if !is_path_segment(namespace) {
                    return Err(invalid(format!("{namespace:?} is not a namespace name")));
                }
                format!("{METRICS_API}/namespaces/{namespace}/pods")
            }
        };
        let client = self.cluster_client(id)?;
        let request = Request::get(path).body(Vec::new()).map_err(|e| {
            IpcError::new(
                ErrorCode::Internal,
                format!("could not build the metrics request: {e}"),
            )
        })?;
        let list: Value = client.request(request).await.map_err(|e| {
            let err = IpcError::from(e);
            if err.code == ErrorCode::NotFound {
                IpcError::new(
                    ErrorCode::NotFound,
                    "the cluster does not serve metrics.k8s.io: metrics-server is not installed",
                )
                .with_details("noMetricsServer")
            } else {
                err
            }
        })?;
        Ok(snapshot(of, &list))
    }
}

/// The items whose usage could be read, sorted, stamped with the newest measurement.
fn snapshot(of: UsageOf, list: &Value) -> UsageSnapshot {
    let mut newest: Option<Timestamp> = None;
    let mut items = Vec::new();
    for item in list["items"].as_array().into_iter().flatten() {
        let usage = match of {
            UsageOf::Nodes => usage_of(&item["usage"]),
            UsageOf::Pods => item["containers"].as_array().and_then(|containers| {
                containers
                    .iter()
                    .try_fold((0.0, 0.0), |(cpu, memory), container| {
                        let (more_cpu, more_memory) = usage_of(&container["usage"])?;
                        Some((cpu + more_cpu, memory + more_memory))
                    })
            }),
        };
        let (Some((cpu_cores, memory_bytes)), Some(name)) =
            (usage, item["metadata"]["name"].as_str())
        else {
            continue;
        };
        let measured = item["timestamp"]
            .as_str()
            .and_then(|t| t.parse::<Timestamp>().ok());
        newest = newest.max(measured);
        items.push(UsageItem {
            namespace: match of {
                UsageOf::Nodes => None,
                UsageOf::Pods => item["metadata"]["namespace"].as_str().map(str::to_owned),
            },
            name: name.to_owned(),
            cpu_cores,
            memory_bytes,
        });
    }
    items.sort_by(|a, b| (&a.namespace, &a.name).cmp(&(&b.namespace, &b.name)));
    UsageSnapshot {
        timestamp: newest.unwrap_or_else(Timestamp::now).to_string(),
        items,
    }
}

/// CPU in cores and memory in bytes, from a `usage` object.
fn usage_of(usage: &Value) -> Option<(f64, f64)> {
    Some((
        parse_quantity(usage["cpu"].as_str()?)?,
        parse_quantity(usage["memory"].as_str()?)?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quantities_become_plain_numbers() {
        let cases = [
            ("250m", 0.25),
            ("1", 1.0),
            ("1.5", 1.5),
            (".5", 0.5),
            ("250000000n", 0.25),
            ("5u", 0.000_005),
            ("2k", 2_000.0),
            ("3M", 3_000_000.0),
            ("1G", 1e9),
            ("1E", 1e18),
            ("1Ki", 1_024.0),
            ("64Mi", 67_108_864.0),
            ("1.5Gi", 1_610_612_736.0),
            ("12e3", 12_000.0),
            ("1E3", 1_000.0),
            ("5e-1", 0.5),
            ("-1m", -0.001),
            ("+2", 2.0),
        ];
        for (text, expected) in cases {
            assert_eq!(parse_quantity(text), Some(expected), "{text}");
        }
        for unusable in [
            "", "m", "Ki", "1.2.3", "1x", "1e", "1e400", "--1", " 1", "1 ",
        ] {
            assert_eq!(parse_quantity(unusable), None, "{unusable:?}");
        }
    }
}
