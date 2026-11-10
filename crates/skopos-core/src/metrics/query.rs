//! `metrics_query` (spec §5.4): a target's templates against Prometheus, six at a time.

use std::collections::BTreeMap;

use futures::stream::{self, StreamExt};
use k8s_openapi::api::core::v1::Pod;
use k8s_openapi::jiff::Timestamp;
use kube::api::{ApiResource, DynamicObject, ListParams};
use kube::core::GroupVersionKind;
use kube::{Api, Client};

use super::prometheus;
use super::templates::{queries, Scope};
use super::{MetricName, MetricsRange, MetricsResult, MetricsTarget, WorkloadKind};
use crate::app_core::AppCore;
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::kubeconfig::ClusterId;
use crate::resources::{invalid, is_path_segment};
use crate::sessions::workload_selector;

/// Queries in flight at once.
const PARALLEL_QUERIES: usize = 6;

/// One series: (timestamp, value) pairs.
type Points = Vec<(f64, f64)>;

impl AppCore {
    /// The target's metrics over `range`. A metric whose query fails or returns no samples is
    /// in `missing`; the call rejects only when every query failed.
    pub async fn metrics_query(
        &self,
        id: &ClusterId,
        target: &MetricsTarget,
        range: MetricsRange,
    ) -> CoreResult<MetricsResult> {
        check_target(target)?;
        let chosen = self.chosen_provider(id, false).await?;
        let Some(endpoint) = chosen.endpoint else {
            return Err(IpcError::new(
                ErrorCode::NotFound,
                "no Prometheus is in use for this cluster",
            )
            .with_details("noPrometheus"));
        };
        let client = self.cluster_client(id)?;
        let window = range.window(Timestamp::now().as_second());
        let pods = match target {
            MetricsTarget::Pod { name, .. } => vec![name.clone()],
            MetricsTarget::Workload {
                namespace,
                name,
                workload_kind,
            } => workload_pods(&client, namespace, name, *workload_kind).await?,
            _ => Vec::new(),
        };
        let scope = match target {
            MetricsTarget::Cluster => Scope::Cluster,
            MetricsTarget::Node { name } => Scope::Node(name),
            MetricsTarget::Pod { namespace, .. } | MetricsTarget::Workload { namespace, .. } => {
                Scope::Pods {
                    namespace,
                    pods: &pods,
                }
            }
            MetricsTarget::Pvc { namespace, name } => Scope::Pvc { namespace, name },
        };
        let planned = queries(&scope, window.step);
        let mut result = MetricsResult {
            start: window.start,
            end: window.end,
            step: window.step,
            series: BTreeMap::new(),
            missing: Vec::new(),
        };
        if matches!(scope, Scope::Pods { pods: [], .. }) {
            // A workload with no pod right now: nothing to ask.
            result.missing = planned.into_iter().map(|(name, _)| name).collect();
            return Ok(result);
        }

        let limit = self.metrics().limits().query;
        let (client, endpoint) = (&client, &endpoint);
        let answers: Vec<(MetricName, CoreResult<Points>)> = stream::iter(planned)
            .map(|(name, query)| async move {
                let points = prometheus::query_range(client, endpoint, &query, window, limit).await;
                (name, points)
            })
            .buffered(PARALLEL_QUERIES)
            .collect()
            .await;

        let mut answered = false;
        let mut service_gone = false;
        let mut first_error = None;
        for (name, answer) in answers {
            match answer {
                Ok(points) if points.is_empty() => {
                    answered = true;
                    result.missing.push(name);
                }
                Ok(points) => {
                    answered = true;
                    result.series.insert(name, points);
                }
                Err(err) => {
                    service_gone |= err.code == ErrorCode::NotFound;
                    first_error.get_or_insert(err);
                    result.missing.push(name);
                }
            }
        }
        if let Some(err) = first_error {
            // Detect again next time: Prometheus may have moved or gone.
            if !answered || service_gone {
                self.metrics().forget(id);
            }
            if !answered {
                return Err(err);
            }
        }
        Ok(result)
    }
}

/// Names reach API paths and PromQL, so they must be single path segments.
fn check_target(target: &MetricsTarget) -> CoreResult<()> {
    let names: Vec<&str> = match target {
        MetricsTarget::Cluster => Vec::new(),
        MetricsTarget::Node { name } => vec![name.as_str()],
        MetricsTarget::Pod { namespace, name }
        | MetricsTarget::Workload {
            namespace, name, ..
        }
        | MetricsTarget::Pvc { namespace, name } => vec![namespace.as_str(), name.as_str()],
    };
    if names.into_iter().all(is_path_segment) {
        Ok(())
    } else {
        Err(invalid(
            "a metrics target needs names without '/', '%', '?', '#' or '\\'",
        ))
    }
}

/// The names of the pods the workload's selector matches now.
async fn workload_pods(
    client: &Client,
    namespace: &str,
    name: &str,
    kind: WorkloadKind,
) -> CoreResult<Vec<String>> {
    let (group, kind_name, plural) = match kind {
        WorkloadKind::Deployment => ("apps", "Deployment", "deployments"),
        WorkloadKind::StatefulSet => ("apps", "StatefulSet", "statefulsets"),
        WorkloadKind::DaemonSet => ("apps", "DaemonSet", "daemonsets"),
        WorkloadKind::ReplicaSet => ("apps", "ReplicaSet", "replicasets"),
        WorkloadKind::Job => ("batch", "Job", "jobs"),
    };
    let resource =
        ApiResource::from_gvk_with_plural(&GroupVersionKind::gvk(group, "v1", kind_name), plural);
    let workload = Api::<DynamicObject>::namespaced_with(client.clone(), namespace, &resource)
        .get(name)
        .await?;
    let selector = workload_selector(&workload.data)?;
    let pods = Api::<Pod>::namespaced(client.clone(), namespace)
        .list(&ListParams::default().labels_from(&selector))
        .await?;
    Ok(pods
        .items
        .into_iter()
        .filter_map(|pod| pod.metadata.name)
        .collect())
}
