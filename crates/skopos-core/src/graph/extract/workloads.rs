//! Pods and the workloads that own them (spec E §4.5, §4.6).

use k8s_openapi::jiff::Timestamp;
use serde_json::Value;

use super::{condition, count, items, text, Item};
use crate::graph::kinds::Kind;
use crate::graph::pod::{pod_status, pod_summary};
use crate::graph::types::{GraphRel, GraphStatus};

/// The ConfigMap every Pod's token volume projects. Spec E §4.5 skips it there.
const ROOT_CA: &str = "kube-root-ca.crt";

pub(super) fn pod(item: &mut Item, pod: &Value) {
    let summary = pod_summary(pod);
    item.status = pod_status(&summary.status);
    item.status_text = Some(summary.status);
    item.fact("Ready", summary.ready);
    item.fact("Restarts", summary.restarts.to_string());
    item.fact_if("Node", text(pod, "/spec/nodeName"));
    item.ready = condition(pod, "Ready").is_some_and(|ready| ready["status"] == "True");

    for volume in items(pod, "/spec/volumes") {
        if let Some(name) = text(volume, "/configMap/name") {
            item.refer(GraphRel::Mounts, Kind::ConfigMap, &name);
        }
        if let Some(name) = text(volume, "/secret/secretName") {
            item.refer(GraphRel::Mounts, Kind::Secret, &name);
        }
        if let Some(name) = text(volume, "/persistentVolumeClaim/claimName") {
            item.refer(GraphRel::Claims, Kind::PersistentVolumeClaim, &name);
        }
        for source in items(volume, "/projected/sources") {
            if let Some(name) = text(source, "/configMap/name").filter(|name| name != ROOT_CA) {
                item.refer(GraphRel::Mounts, Kind::ConfigMap, &name);
            }
            if let Some(name) = text(source, "/secret/name") {
                item.refer(GraphRel::Mounts, Kind::Secret, &name);
            }
        }
    }
    let containers = items(pod, "/spec/containers")
        .iter()
        .chain(items(pod, "/spec/initContainers"));
    for container in containers {
        for env in items(container, "/env") {
            if let Some(name) = text(env, "/valueFrom/configMapKeyRef/name") {
                item.refer(GraphRel::Env, Kind::ConfigMap, &name);
            }
            if let Some(name) = text(env, "/valueFrom/secretKeyRef/name") {
                item.refer(GraphRel::Env, Kind::Secret, &name);
            }
        }
        for source in items(container, "/envFrom") {
            if let Some(name) = text(source, "/configMapRef/name") {
                item.refer(GraphRel::Env, Kind::ConfigMap, &name);
            }
            if let Some(name) = text(source, "/secretRef/name") {
                item.refer(GraphRel::Env, Kind::Secret, &name);
            }
        }
    }
    let account = text(pod, "/spec/serviceAccountName").unwrap_or_else(|| "default".to_owned());
    item.refer(GraphRel::RunsAs, Kind::ServiceAccount, &account);
}

/// Spec E §4.6: a workload compares what it has with what it wants. `some` is the text when it
/// has part of it.
fn replica_status(desired: i64, have: i64, some: String) -> (GraphStatus, Option<String>) {
    if desired <= 0 {
        (GraphStatus::Neutral, Some("Scaled to zero".to_owned()))
    } else if have >= desired {
        (GraphStatus::Nominal, None)
    } else if have > 0 {
        (GraphStatus::Warning, Some(some))
    } else {
        (
            GraphStatus::Critical,
            Some(format!("0 of {desired} available")),
        )
    }
}

/// The template's first image, followed by "+N" when there are more containers.
fn image(object: &Value) -> Option<String> {
    let containers = items(object, "/spec/template/spec/containers");
    let first = text(containers.first()?, "/image")?;
    Some(match containers.len() {
        1 => first,
        n => format!("{first} +{}", n - 1),
    })
}

pub(super) fn deployment(item: &mut Item, object: &Value) {
    let desired = count(object, "/spec/replicas", 1);
    let available = count(object, "/status/availableReplicas", 0);
    (item.status, item.status_text) = replica_status(
        desired,
        available,
        format!("{available} of {desired} available"),
    );
    item.fact("Replicas", format!("{available}/{desired} available"));
    item.fact_if("Strategy", text(object, "/spec/strategy/type"));
    item.fact_if("Image", image(object));
}

pub(super) fn stateful_set(item: &mut Item, object: &Value) {
    let desired = count(object, "/spec/replicas", 1);
    let available = count(object, "/status/availableReplicas", 0);
    let ready = count(object, "/status/readyReplicas", 0);
    (item.status, item.status_text) = replica_status(
        desired,
        available,
        format!("{available} of {desired} available"),
    );
    item.fact("Replicas", format!("{ready}/{desired} ready"));
    item.fact_if("Image", image(object));
}

pub(super) fn daemon_set(item: &mut Item, object: &Value) {
    let desired = count(object, "/status/desiredNumberScheduled", 0);
    let ready = count(object, "/status/numberReady", 0);
    (item.status, item.status_text) =
        replica_status(desired, ready, format!("{ready} of {desired} available"));
    item.fact("Pods", format!("{ready}/{desired} ready"));
    item.fact_if("Image", image(object));
}

pub(super) fn replica_set(item: &mut Item, object: &Value) {
    let desired = count(object, "/spec/replicas", 1);
    let available = count(object, "/status/availableReplicas", 0);
    let ready = count(object, "/status/readyReplicas", 0);
    (item.status, item.status_text) = replica_status(
        desired,
        available,
        format!("{available} of {desired} Pods ready"),
    );
    item.scaled_to_zero = desired == 0;
    item.fact("Pods", desired.to_string());
    item.fact("Ready", ready.to_string());
    item.fact_if(
        "Revision",
        text(
            object,
            "/metadata/annotations/deployment.kubernetes.io~1revision",
        ),
    );
}

pub(super) fn job(item: &mut Item, object: &Value) {
    let holds = |kind: &str| condition(object, kind).is_some_and(|c| c["status"] == "True");
    let complete = holds("Complete");
    (item.status, item.status_text) = if complete {
        (GraphStatus::Neutral, Some("Complete".to_owned()))
    } else if holds("Failed") {
        (GraphStatus::Critical, Some("Failed".to_owned()))
    } else {
        (GraphStatus::Nominal, Some("Running".to_owned()))
    };
    let succeeded = count(object, "/status/succeeded", 0);
    let completions = count(object, "/spec/completions", 1);
    item.fact("Completions", format!("{succeeded}/{completions}"));
    item.fact("Active", count(object, "/status/active", 0).to_string());
    if complete {
        item.fact_if("Duration", duration(object));
    }
}

/// From `startTime` to `completionTime`, as "41s", "3m4s" or "1h2m".
fn duration(job: &Value) -> Option<String> {
    let start: Timestamp = text(job, "/status/startTime")?.parse().ok()?;
    let end: Timestamp = text(job, "/status/completionTime")?.parse().ok()?;
    let seconds = end.as_second() - start.as_second();
    if seconds < 0 {
        None
    } else if seconds < 60 {
        Some(format!("{seconds}s"))
    } else if seconds < 3600 {
        Some(format!("{}m{}s", seconds / 60, seconds % 60))
    } else {
        Some(format!("{}h{}m", seconds / 3600, seconds % 3600 / 60))
    }
}

pub(super) fn cron_job(item: &mut Item, object: &Value) {
    let suspended = object
        .pointer("/spec/suspend")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if suspended {
        item.status = GraphStatus::Neutral;
        item.status_text = Some("Suspended".to_owned());
    } else {
        item.status = GraphStatus::Nominal;
    }
    item.fact_if("Schedule", text(object, "/spec/schedule"));
    item.fact("Suspend", if suspended { "Yes" } else { "No" });
    item.fact_if("Last schedule", text(object, "/status/lastScheduleTime"));
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::graph::extract::test_support::{facts, item, refs};
    use crate::graph::kinds::Kind;
    use crate::graph::types::{GraphRel, GraphStatus};

    fn running_pod() -> serde_json::Value {
        json!({
            "metadata": { "name": "web-1", "namespace": "a" },
            "spec": {
                "nodeName": "node-1",
                "containers": [{ "name": "app" }, { "name": "side" }],
            },
            "status": {
                "phase": "Running",
                "conditions": [{ "type": "Ready", "status": "True" }],
                "containerStatuses": [
                    { "name": "app", "ready": true, "restartCount": 2, "state": { "running": {} } },
                    { "name": "side", "ready": true, "restartCount": 1, "state": { "running": {} } },
                ],
            },
        })
    }

    #[test]
    fn a_pod_has_its_table_status_and_facts() {
        let pod = item(Kind::Pod, running_pod());
        assert_eq!(
            (pod.status, pod.status_text.as_deref()),
            (GraphStatus::Nominal, Some("Running"))
        );
        assert_eq!(
            facts(&pod),
            [("Ready", "2/2"), ("Restarts", "3"), ("Node", "node-1")]
        );
        assert!(pod.ready);

        let mut crashing = running_pod();
        crashing["status"]["conditions"][0]["status"] = json!("False");
        crashing["status"]["containerStatuses"][0]["state"] =
            json!({ "waiting": { "reason": "CrashLoopBackOff" } });
        crashing["status"]["containerStatuses"][0]["ready"] = json!(false);
        crashing["spec"].as_object_mut().unwrap().remove("nodeName");
        let crashing = item(Kind::Pod, crashing);
        assert_eq!(
            (crashing.status, crashing.status_text.as_deref()),
            (GraphStatus::Critical, Some("CrashLoopBackOff"))
        );
        assert_eq!(facts(&crashing), [("Ready", "1/2"), ("Restarts", "3")]);
        assert!(!crashing.ready);
    }

    #[test]
    fn a_pod_refers_to_what_it_mounts_reads_runs_as_and_claims() {
        let pod = item(
            Kind::Pod,
            json!({
                "metadata": { "name": "web-1", "namespace": "a" },
                "spec": {
                    "volumes": [
                        { "configMap": { "name": "web-config" } },
                        { "secret": { "secretName": "web-tls" } },
                        { "persistentVolumeClaim": { "claimName": "web-data" } },
                        { "emptyDir": {} },
                        { "projected": { "sources": [
                            { "serviceAccountToken": { "path": "token" } },
                            { "configMap": { "name": "kube-root-ca.crt" } },
                            { "configMap": { "name": "bundle" } },
                            { "secret": { "name": "extra" } },
                        ] } },
                    ],
                    "initContainers": [{ "name": "setup", "env": [
                        { "valueFrom": { "configMapKeyRef": { "name": "init-config" } } },
                    ] }],
                    "containers": [{ "name": "app",
                        "env": [{ "valueFrom": { "secretKeyRef": { "name": "db" } } }, {}],
                        "envFrom": [{ "configMapRef": { "name": "flags" } }, { "secretRef": { "name": "api" } }],
                    }],
                },
            }),
        );
        assert_eq!(
            refs(&pod),
            [
                (GraphRel::Mounts, "ConfigMap/a/web-config".to_owned(), false),
                (GraphRel::Mounts, "Secret/a/web-tls".to_owned(), false),
                (
                    GraphRel::Claims,
                    "PersistentVolumeClaim/a/web-data".to_owned(),
                    false
                ),
                (GraphRel::Mounts, "ConfigMap/a/bundle".to_owned(), false),
                (GraphRel::Mounts, "Secret/a/extra".to_owned(), false),
                (GraphRel::Env, "Secret/a/db".to_owned(), false),
                (GraphRel::Env, "ConfigMap/a/flags".to_owned(), false),
                (GraphRel::Env, "Secret/a/api".to_owned(), false),
                (GraphRel::Env, "ConfigMap/a/init-config".to_owned(), false),
                (
                    GraphRel::RunsAs,
                    "ServiceAccount/a/default".to_owned(),
                    false
                ),
            ]
        );
    }

    #[test]
    fn the_root_ca_counts_when_it_is_named_outside_a_projected_volume() {
        let pod = item(
            Kind::Pod,
            json!({
                "metadata": { "name": "p", "namespace": "a" },
                "spec": {
                    "serviceAccountName": "web",
                    "volumes": [{ "configMap": { "name": "kube-root-ca.crt" } }],
                    "containers": [{ "name": "app" }],
                },
            }),
        );
        assert_eq!(
            refs(&pod),
            [
                (
                    GraphRel::Mounts,
                    "ConfigMap/a/kube-root-ca.crt".to_owned(),
                    false
                ),
                (GraphRel::RunsAs, "ServiceAccount/a/web".to_owned(), false),
            ]
        );
    }

    #[test]
    fn a_reference_given_twice_is_one_edge() {
        let pod = item(
            Kind::Pod,
            json!({
                "metadata": { "name": "p", "namespace": "a" },
                "spec": {
                    "volumes": [{ "secret": { "secretName": "s" } }, { "secret": { "secretName": "s" } }],
                    "containers": [
                        { "name": "a", "envFrom": [{ "secretRef": { "name": "s" } }] },
                        { "name": "b", "env": [{ "valueFrom": { "secretKeyRef": { "name": "s" } } }] },
                    ],
                },
            }),
        );
        assert_eq!(
            refs(&pod),
            [
                (GraphRel::Mounts, "Secret/a/s".to_owned(), false),
                (GraphRel::Env, "Secret/a/s".to_owned(), false),
                (
                    GraphRel::RunsAs,
                    "ServiceAccount/a/default".to_owned(),
                    false
                ),
            ]
        );
    }

    fn deployment(replicas: Option<i64>, available: Option<i64>) -> serde_json::Value {
        let mut object = json!({
            "metadata": { "name": "web", "namespace": "a" },
            "spec": {
                "strategy": { "type": "RollingUpdate" },
                "template": { "spec": { "containers": [{ "image": "nginx:1.27" }, { "image": "proxy:2" }] } },
            },
            "status": {},
        });
        if let Some(replicas) = replicas {
            object["spec"]["replicas"] = json!(replicas);
        }
        if let Some(available) = available {
            object["status"]["availableReplicas"] = json!(available);
        }
        object
    }

    #[test]
    fn a_deployment_compares_available_with_desired() {
        let cases = [
            (Some(0), None, GraphStatus::Neutral, Some("Scaled to zero")),
            (Some(2), Some(2), GraphStatus::Nominal, None),
            (None, Some(1), GraphStatus::Nominal, None),
            (
                Some(3),
                Some(1),
                GraphStatus::Warning,
                Some("1 of 3 available"),
            ),
            (
                Some(2),
                None,
                GraphStatus::Critical,
                Some("0 of 2 available"),
            ),
        ];
        for (replicas, available, status, text) in cases {
            let item = item(Kind::Deployment, deployment(replicas, available));
            assert_eq!(
                (item.status, item.status_text.as_deref()),
                (status, text),
                "{replicas:?} {available:?}"
            );
        }
        let item = item(Kind::Deployment, deployment(Some(3), Some(1)));
        assert_eq!(
            facts(&item),
            [
                ("Replicas", "1/3 available"),
                ("Strategy", "RollingUpdate"),
                ("Image", "nginx:1.27 +1"),
            ]
        );
    }

    #[test]
    fn a_stateful_set_shows_ready_and_rates_available() {
        let item = item(
            Kind::StatefulSet,
            json!({
                "metadata": { "name": "db", "namespace": "a" },
                "spec": { "replicas": 3, "template": { "spec": { "containers": [{ "image": "postgres:17" }] } } },
                "status": { "readyReplicas": 2, "availableReplicas": 2 },
            }),
        );
        assert_eq!(
            (item.status, item.status_text.as_deref()),
            (GraphStatus::Warning, Some("2 of 3 available"))
        );
        assert_eq!(
            facts(&item),
            [("Replicas", "2/3 ready"), ("Image", "postgres:17")]
        );
    }

    #[test]
    fn a_daemon_set_compares_ready_with_desired() {
        let item = item(
            Kind::DaemonSet,
            json!({
                "metadata": { "name": "agent", "namespace": "a" },
                "spec": { "template": { "spec": { "containers": [{ "image": "agent:1" }] } } },
                "status": { "desiredNumberScheduled": 3, "numberReady": 3 },
            }),
        );
        assert_eq!(
            (item.status, item.status_text.as_deref()),
            (GraphStatus::Nominal, None)
        );
        assert_eq!(facts(&item), [("Pods", "3/3 ready"), ("Image", "agent:1")]);
        let none = item_of_daemon_set(json!({ "desiredNumberScheduled": 2 }));
        assert_eq!(
            (none.status, none.status_text.as_deref()),
            (GraphStatus::Critical, Some("0 of 2 available"))
        );
        let zero = item_of_daemon_set(json!({}));
        assert_eq!(zero.status_text.as_deref(), Some("Scaled to zero"));
    }

    fn item_of_daemon_set(status: serde_json::Value) -> crate::graph::extract::Item {
        item(
            Kind::DaemonSet,
            json!({ "metadata": { "name": "d", "namespace": "a" }, "status": status }),
        )
    }

    #[test]
    fn a_replica_set_shows_pods_ready_and_revision() {
        let item = item(
            Kind::ReplicaSet,
            json!({
                "metadata": {
                    "name": "web-1",
                    "namespace": "a",
                    "annotations": { "deployment.kubernetes.io/revision": "14" },
                },
                "spec": { "replicas": 2 },
                "status": { "readyReplicas": 1, "availableReplicas": 1 },
            }),
        );
        assert_eq!(
            (item.status, item.status_text.as_deref()),
            (GraphStatus::Warning, Some("1 of 2 Pods ready"))
        );
        assert_eq!(
            facts(&item),
            [("Pods", "2"), ("Ready", "1"), ("Revision", "14")]
        );
        assert!(!item.scaled_to_zero);

        let old = item_of_replica_set(0);
        assert!(old.scaled_to_zero);
        assert_eq!(facts(&old), [("Pods", "0"), ("Ready", "0")]);
    }

    fn item_of_replica_set(replicas: i64) -> crate::graph::extract::Item {
        item(
            Kind::ReplicaSet,
            json!({ "metadata": { "name": "r", "namespace": "a" }, "spec": { "replicas": replicas } }),
        )
    }

    #[test]
    fn a_job_reads_its_conditions() {
        let complete = item(
            Kind::Job,
            json!({
                "metadata": { "name": "j", "namespace": "a" },
                "status": {
                    "conditions": [{ "type": "Complete", "status": "True" }],
                    "succeeded": 1,
                    "startTime": "2026-11-12T08:00:00Z",
                    "completionTime": "2026-11-12T08:00:41Z",
                },
            }),
        );
        assert_eq!(
            (complete.status, complete.status_text.as_deref()),
            (GraphStatus::Neutral, Some("Complete"))
        );
        assert_eq!(
            facts(&complete),
            [("Completions", "1/1"), ("Active", "0"), ("Duration", "41s")]
        );

        let failed = item(
            Kind::Job,
            json!({
                "metadata": { "name": "j", "namespace": "a" },
                "spec": { "completions": 3 },
                "status": { "conditions": [{ "type": "Failed", "status": "True" }], "succeeded": 1 },
            }),
        );
        assert_eq!(
            (failed.status, failed.status_text.as_deref()),
            (GraphStatus::Critical, Some("Failed"))
        );
        assert_eq!(facts(&failed), [("Completions", "1/3"), ("Active", "0")]);

        let running = item(
            Kind::Job,
            json!({
                "metadata": { "name": "j", "namespace": "a" },
                "status": { "active": 1, "conditions": [{ "type": "Complete", "status": "False" }] },
            }),
        );
        assert_eq!(
            (running.status, running.status_text.as_deref()),
            (GraphStatus::Nominal, Some("Running"))
        );
        assert_eq!(facts(&running), [("Completions", "0/1"), ("Active", "1")]);
    }

    #[test]
    fn durations_read_like_the_board() {
        let job = |start: &str, end: &str| json!({ "status": { "startTime": start, "completionTime": end } });
        assert_eq!(
            duration(&job("2026-11-12T08:00:00Z", "2026-11-12T08:00:41Z")).as_deref(),
            Some("41s")
        );
        assert_eq!(
            duration(&job("2026-11-12T08:00:00Z", "2026-11-12T08:03:04Z")).as_deref(),
            Some("3m4s")
        );
        assert_eq!(
            duration(&job("2026-11-12T08:00:00Z", "2026-11-12T09:02:59Z")).as_deref(),
            Some("1h2m")
        );
        assert_eq!(
            duration(&job("2026-11-12T09:00:00Z", "2026-11-12T08:00:00Z")),
            None
        );
        assert_eq!(duration(&job("not a time", "2026-11-12T08:00:00Z")), None);
    }

    #[test]
    fn a_cron_job_reads_its_suspend_flag() {
        let suspended = item(
            Kind::CronJob,
            json!({
                "metadata": { "name": "c", "namespace": "a" },
                "spec": { "schedule": "*/5 * * * *", "suspend": true },
                "status": { "lastScheduleTime": "2026-11-12T08:00:00Z" },
            }),
        );
        assert_eq!(
            (suspended.status, suspended.status_text.as_deref()),
            (GraphStatus::Neutral, Some("Suspended"))
        );
        assert_eq!(
            facts(&suspended),
            [
                ("Schedule", "*/5 * * * *"),
                ("Suspend", "Yes"),
                ("Last schedule", "2026-11-12T08:00:00Z"),
            ]
        );
        let active = item(
            Kind::CronJob,
            json!({ "metadata": { "name": "c", "namespace": "a" }, "spec": { "schedule": "@daily" } }),
        );
        assert_eq!(
            (active.status, active.status_text.as_deref()),
            (GraphStatus::Nominal, None)
        );
        assert_eq!(facts(&active), [("Schedule", "@daily"), ("Suspend", "No")]);
    }
}
