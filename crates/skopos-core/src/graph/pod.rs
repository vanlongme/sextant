//! The Pod status the Pods table shows, ported from `podSummary` in
//! `ui/src/kinds/workloads/pod.ts` (the `kubectl get pods` rules), so the map agrees with it.

use serde_json::Value;

use super::types::GraphStatus;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PodSummary {
    pub status: String,
    /// `ready/total`, for example `1/2`.
    pub ready: String,
    pub restarts: u64,
}

fn list(value: &Value) -> &[Value] {
    value.as_array().map_or(&[], Vec::as_slice)
}

/// A non-empty string, as JavaScript's truthiness reads one.
fn truthy(value: &Value) -> Option<&str> {
    value.as_str().filter(|text| !text.is_empty())
}

fn is_restartable(container: Option<&Value>) -> bool {
    container.is_some_and(|c| c["restartPolicy"] == "Always")
}

fn terminated_text(terminated: &Value, prefix: &str) -> String {
    if let Some(reason) = truthy(&terminated["reason"]) {
        return format!("{prefix}{reason}");
    }
    if let Some(signal) = terminated["signal"].as_i64().filter(|signal| *signal != 0) {
        return format!("{prefix}Signal:{signal}");
    }
    let code = terminated["exitCode"].as_i64().unwrap_or(0);
    format!("{prefix}ExitCode:{code}")
}

pub(crate) fn pod_summary(pod: &Value) -> PodSummary {
    let status = &pod["status"];
    let spec = &pod["spec"];
    let conditions = list(&status["conditions"]);
    let inits = list(&spec["initContainers"]);
    let total =
        list(&spec["containers"]).len() + inits.iter().filter(|c| is_restartable(Some(*c))).count();
    let mut ready = 0;
    let mut restarts: u64 = 0;
    let mut restartable_restarts: u64 = 0;
    let mut reason = truthy(&status["reason"])
        .or_else(|| truthy(&status["phase"]))
        .unwrap_or("Unknown")
        .to_owned();
    for condition in conditions {
        if condition["type"] == "PodScheduled" && condition["reason"] == "SchedulingGated" {
            reason = "SchedulingGated".to_owned();
        }
    }

    let mut initializing = false;
    let init_statuses = list(&status["initContainerStatuses"]);
    for (index, container) in init_statuses.iter().enumerate() {
        let name = container["name"].as_str().unwrap_or("");
        let restartable = is_restartable(
            inits
                .iter()
                .find(|spec| spec["name"].as_str() == Some(name)),
        );
        let count = container["restartCount"].as_u64().unwrap_or(0);
        restarts += count;
        if restartable {
            restartable_restarts += count;
        }
        let terminated = &container["state"]["terminated"];
        let waiting = &container["state"]["waiting"];
        if terminated.is_object() && terminated["exitCode"].as_i64().unwrap_or(0) == 0 {
            continue;
        }
        if restartable && container["started"] == true {
            if container["ready"] == true {
                ready += 1;
            }
            continue;
        }
        reason = if terminated.is_object() {
            terminated_text(terminated, "Init:")
        } else if let Some(waiting) =
            truthy(&waiting["reason"]).filter(|reason| *reason != "PodInitializing")
        {
            format!("Init:{waiting}")
        } else {
            format!("Init:{index}/{}", inits.len())
        };
        initializing = true;
        break;
    }

    let holds = |kind: &str| {
        conditions
            .iter()
            .any(|c| c["type"] == kind && c["status"] == "True")
    };
    if !initializing || holds("Initialized") {
        restarts = restartable_restarts;
        let mut has_running = false;
        for container in list(&status["containerStatuses"]).iter().rev() {
            restarts += container["restartCount"].as_u64().unwrap_or(0);
            let state = &container["state"];
            if let Some(waiting) = truthy(&state["waiting"]["reason"]) {
                reason = waiting.to_owned();
            } else if state["terminated"].is_object() {
                reason = terminated_text(&state["terminated"], "");
            } else if container["ready"] == true && state["running"].is_object() {
                has_running = true;
                ready += 1;
            }
        }
        if reason == "Completed" && has_running {
            reason = if holds("Ready") {
                "Running"
            } else {
                "NotReady"
            }
            .to_owned();
        }
    }

    let deleting = truthy(&pod["metadata"]["deletionTimestamp"]).is_some();
    let phase = status["phase"].as_str();
    if deleting && status["reason"] == "NodeLost" {
        reason = "Unknown".to_owned();
    } else if deleting && phase != Some("Succeeded") && phase != Some("Failed") {
        reason = "Terminating".to_owned();
    }

    PodSummary {
        status: reason,
        ready: format!("{ready}/{total}"),
        restarts,
    }
}

/// Spec E §4.6: the node status of a Pod status text.
pub(crate) fn pod_status(text: &str) -> GraphStatus {
    match text {
        "Running" => GraphStatus::Nominal,
        "Completed" | "Succeeded" => GraphStatus::Neutral,
        "ContainerCreating" | "PodInitializing" | "SchedulingGated" | "Pending" | "NotReady"
        | "Terminating" | "Unknown" => GraphStatus::Warning,
        text if is_init_progress(text) => GraphStatus::Warning,
        _ => GraphStatus::Critical,
    }
}

/// `Init:N/M`, as the interface's `/^Init:\d+\/\d+$/` matches it.
fn is_init_progress(text: &str) -> bool {
    let digits = |part: &str| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit());
    text.strip_prefix("Init:")
        .and_then(|rest| rest.split_once('/'))
        .is_some_and(|(done, total)| digits(done) && digits(total))
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::*;

    /// Merges `extra` into the object `base`, one level deep.
    fn merge(mut base: Value, extra: Value) -> Value {
        if let (Some(base), Some(extra)) = (base.as_object_mut(), extra.as_object()) {
            for (key, value) in extra {
                base.insert(key.clone(), value.clone());
            }
        }
        base
    }

    fn running() -> Value {
        json!({ "state": { "running": {} }, "ready": true, "restartCount": 0, "name": "a" })
    }

    /// The interface test's `pod(status, spec, metadata)`.
    fn pod(status: Value, spec: Value, metadata: Value) -> Value {
        json!({
            "metadata": merge(json!({ "name": "p" }), metadata),
            "spec": merge(json!({ "containers": [{ "name": "a" }] }), spec),
            "status": status,
        })
    }

    fn with_status(status: Value) -> Value {
        pod(status, json!({}), json!({}))
    }

    /// The cases of `podSummary follows kubectl` in `ui/src/kinds/workloads/pod.test.ts`.
    #[test]
    fn pod_summary_follows_kubectl() {
        let deleting = json!({ "deletionTimestamp": "2026-01-01T00:00:00Z" });
        let cases = [
            (
                "phase",
                with_status(json!({ "phase": "Pending" })),
                "Pending",
            ),
            (
                "pod reason wins over phase",
                with_status(json!({ "phase": "Failed", "reason": "Evicted" })),
                "Evicted",
            ),
            (
                "scheduling gate",
                with_status(
                    json!({ "phase": "Pending", "conditions": [{ "type": "PodScheduled", "reason": "SchedulingGated" }] }),
                ),
                "SchedulingGated",
            ),
            (
                "waiting reason",
                with_status(
                    json!({ "phase": "Running", "containerStatuses": [{ "state": { "waiting": { "reason": "CrashLoopBackOff" } } }] }),
                ),
                "CrashLoopBackOff",
            ),
            (
                "terminated reason",
                with_status(
                    json!({ "phase": "Failed", "containerStatuses": [{ "state": { "terminated": { "reason": "OOMKilled", "exitCode": 137 } } }] }),
                ),
                "OOMKilled",
            ),
            (
                "terminated by signal",
                with_status(
                    json!({ "phase": "Failed", "containerStatuses": [{ "state": { "terminated": { "signal": 9, "exitCode": 0 } } }] }),
                ),
                "Signal:9",
            ),
            (
                "terminated with a code",
                with_status(
                    json!({ "phase": "Failed", "containerStatuses": [{ "state": { "terminated": { "exitCode": 3 } } }] }),
                ),
                "ExitCode:3",
            ),
            (
                "running",
                with_status(json!({ "phase": "Running", "containerStatuses": [running()] })),
                "Running",
            ),
            (
                "completed with one still running and ready",
                with_status(json!({
                    "phase": "Running",
                    "conditions": [{ "type": "Ready", "status": "True" }],
                    "containerStatuses": [running(), { "state": { "terminated": { "reason": "Completed", "exitCode": 0 } } }],
                })),
                "Running",
            ),
            (
                "completed with one running, pod not ready",
                with_status(json!({
                    "phase": "Running",
                    "containerStatuses": [running(), { "state": { "terminated": { "reason": "Completed", "exitCode": 0 } } }],
                })),
                "NotReady",
            ),
            (
                "init in progress",
                pod(
                    json!({ "phase": "Pending", "initContainerStatuses": [{ "name": "i", "state": { "running": {} } }] }),
                    json!({ "initContainers": [{ "name": "i" }, { "name": "j" }] }),
                    json!({}),
                ),
                "Init:0/2",
            ),
            (
                "init waiting",
                pod(
                    json!({ "phase": "Pending", "initContainerStatuses": [{ "name": "i", "state": { "waiting": { "reason": "ImagePullBackOff" } } }] }),
                    json!({ "initContainers": [{ "name": "i" }] }),
                    json!({}),
                ),
                "Init:ImagePullBackOff",
            ),
            (
                "init failed",
                pod(
                    json!({ "phase": "Pending", "initContainerStatuses": [{ "name": "i", "state": { "terminated": { "reason": "Error", "exitCode": 1 } } }] }),
                    json!({ "initContainers": [{ "name": "i" }] }),
                    json!({}),
                ),
                "Init:Error",
            ),
            (
                "init failed by signal",
                pod(
                    json!({ "phase": "Pending", "initContainerStatuses": [{ "name": "i", "state": { "terminated": { "signal": 9, "exitCode": 137 } } }] }),
                    json!({ "initContainers": [{ "name": "i" }] }),
                    json!({}),
                ),
                "Init:Signal:9",
            ),
            (
                "init failed with a code",
                pod(
                    json!({ "phase": "Pending", "initContainerStatuses": [{ "name": "i", "state": { "terminated": { "exitCode": 2 } } }] }),
                    json!({ "initContainers": [{ "name": "i" }] }),
                    json!({}),
                ),
                "Init:ExitCode:2",
            ),
            (
                "init done",
                pod(
                    json!({
                        "phase": "Running",
                        "initContainerStatuses": [{ "name": "i", "state": { "terminated": { "exitCode": 0 } } }],
                        "containerStatuses": [running()],
                    }),
                    json!({ "initContainers": [{ "name": "i" }] }),
                    json!({}),
                ),
                "Running",
            ),
            (
                "terminating",
                pod(
                    json!({ "phase": "Running", "containerStatuses": [running()] }),
                    json!({}),
                    deleting.clone(),
                ),
                "Terminating",
            ),
            (
                "terminating on a lost node",
                pod(
                    json!({ "phase": "Running", "reason": "NodeLost" }),
                    json!({}),
                    deleting.clone(),
                ),
                "Unknown",
            ),
            (
                "a finished pod being deleted keeps its status",
                pod(
                    json!({ "phase": "Succeeded", "containerStatuses": [{ "state": { "terminated": { "reason": "Completed", "exitCode": 0 } } }] }),
                    json!({}),
                    deleting,
                ),
                "Completed",
            ),
        ];
        for (name, object, expected) in cases {
            assert_eq!(pod_summary(&object).status, expected, "{name}");
        }
    }

    #[test]
    fn a_pod_with_nothing_yet_does_not_panic() {
        assert_eq!(
            pod_summary(&json!({ "metadata": { "name": "p" } })),
            PodSummary {
                status: "Unknown".into(),
                ready: "0/0".into(),
                restarts: 0
            }
        );
    }

    #[test]
    fn ready_counts_running_and_ready_containers_over_the_spec_s_containers() {
        let object = pod(
            json!({ "containerStatuses": [running(), merge(running(), json!({ "ready": false }))] }),
            json!({ "containers": [{ "name": "a" }, { "name": "b" }] }),
            json!({}),
        );
        assert_eq!(pod_summary(&object).ready, "1/2");
    }

    #[test]
    fn restarts_add_up_regular_containers_once_init_is_done() {
        let object = pod(
            json!({
                "initContainerStatuses": [{ "name": "i", "restartCount": 5, "state": { "terminated": { "exitCode": 0 } } }],
                "containerStatuses": [
                    merge(running(), json!({ "restartCount": 2 })),
                    merge(running(), json!({ "restartCount": 1 })),
                ],
            }),
            json!({ "initContainers": [{ "name": "i" }] }),
            json!({}),
        );
        assert_eq!(pod_summary(&object).restarts, 3);
    }

    #[test]
    fn a_restartable_init_container_counts_towards_ready_and_restarts() {
        let object = pod(
            json!({
                "phase": "Running",
                "initContainerStatuses": [{ "name": "side", "restartCount": 4, "started": true, "ready": true, "state": { "running": {} } }],
                "containerStatuses": [merge(running(), json!({ "restartCount": 1 }))],
            }),
            json!({ "initContainers": [{ "name": "side", "restartPolicy": "Always" }] }),
            json!({}),
        );
        assert_eq!(
            pod_summary(&object),
            PodSummary {
                status: "Running".into(),
                ready: "2/2".into(),
                restarts: 5
            }
        );
    }

    /// The labels of the interface's `podStatus tones` test, with spec E §4.6's statuses.
    #[test]
    fn pod_status_follows_spec_e() {
        use GraphStatus::{Critical, Neutral, Nominal, Warning};
        let cases = [
            ("Running", Nominal),
            ("Completed", Neutral),
            ("Succeeded", Neutral),
            ("ContainerCreating", Warning),
            ("PodInitializing", Warning),
            ("Init:0/2", Warning),
            ("SchedulingGated", Warning),
            ("Pending", Warning),
            ("NotReady", Warning),
            ("Terminating", Warning),
            ("Unknown", Warning),
            ("CrashLoopBackOff", Critical),
            ("ImagePullBackOff", Critical),
            ("Error", Critical),
            ("Evicted", Critical),
            ("Init:Error", Critical),
            ("ExitCode:3", Critical),
            ("Failed", Critical),
            ("Init:1/", Critical),
        ];
        for (label, expected) in cases {
            let object = with_status(json!({ "phase": label, "reason": label }));
            assert_eq!(
                pod_status(&pod_summary(&object).status),
                expected,
                "{label}"
            );
        }
    }
}
