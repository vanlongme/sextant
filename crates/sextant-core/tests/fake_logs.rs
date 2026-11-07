//! Log sessions against the fake API server.

mod support;

use std::time::Duration;

use serde_json::{json, Value};
use sextant_core::app_core::AppCore;
use sextant_core::error::ErrorCode;
use sextant_core::kubeconfig::ClusterId;
use sextant_core::resources::ResourceRef;
use sextant_core::sessions::{LogEndReason, LogEvent, LogLine, LogMarker, LogOptions, LogTarget};
use sextant_fakekube::{DenyRule, FakeKube, FakeKubeConfig, FakeLogLine};
use support::connected_fake;
use tokio::sync::mpsc;

const LIMIT: Duration = Duration::from_secs(30);
const ONE: &str = "2026-01-01T00:00:01.000000001Z";
const TWO: &str = "2026-01-01T00:00:01.000000002Z";
const THREE: &str = "2026-01-01T00:00:01.000000003Z";

fn follow() -> LogOptions {
    LogOptions {
        follow: true,
        previous: false,
        tail_lines: None,
        since_seconds: None,
    }
}

fn once() -> LogOptions {
    LogOptions {
        follow: false,
        ..follow()
    }
}

fn pod_target(container: Option<&str>) -> LogTarget {
    LogTarget::Pod {
        namespace: "default".into(),
        pod: "p".into(),
        container: container.map(str::to_owned),
    }
}

fn pod_with_containers(fake: &FakeKube, status: Value) {
    fake.upsert(
        "pods",
        json!({
            "metadata": { "name": "p", "namespace": "default", "uid": "uid-1" },
            "spec": {
                "restartPolicy": "Always",
                "initContainers": [{ "name": "setup" }],
                "containers": [{ "name": "main" }],
            },
            "status": status,
        }),
    );
}

fn add_line(fake: &FakeKube, container: &str, stamp: &str, text: &str) {
    fake.add_log_lines("default", "p", container, &[FakeLogLine::new(stamp, text)]);
}

fn start(
    core: &AppCore,
    id: &ClusterId,
    target: LogTarget,
    options: LogOptions,
) -> (String, mpsc::Receiver<LogEvent>) {
    let (tx, rx) = mpsc::channel(32);
    (core.logs_start(id, target, options, tx).unwrap(), rx)
}

/// Receives until an event matches, and returns everything received so far.
async fn wait_until(
    rx: &mut mpsc::Receiver<LogEvent>,
    done: impl Fn(&LogEvent) -> bool,
) -> Vec<LogEvent> {
    let mut events = Vec::new();
    tokio::time::timeout(LIMIT, async {
        while let Some(event) = rx.recv().await {
            let stop = done(&event);
            events.push(event);
            if stop {
                return;
            }
        }
        panic!("the session ended without the awaited event: {events:?}");
    })
    .await
    .expect("the awaited event never came");
    events
}

async fn wait_for_open_stream(fake: &FakeKube) {
    tokio::time::timeout(LIMIT, async {
        while fake.open_log_count() == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("no stream opened");
}

fn is_last(event: &LogEvent) -> bool {
    matches!(event, LogEvent::Ended { .. } | LogEvent::Failed { .. })
}

fn texts(events: &[LogEvent]) -> Vec<String> {
    lines(events).iter().map(|line| line.text.clone()).collect()
}

fn lines(events: &[LogEvent]) -> Vec<LogLine> {
    events
        .iter()
        .filter_map(|event| match event {
            LogEvent::Lines { lines } => Some(lines.clone()),
            _ => None,
        })
        .flatten()
        .collect()
}

fn has_marker(event: &LogEvent, wanted: LogMarker) -> bool {
    matches!(event, LogEvent::Marker { marker, .. } if *marker == wanted)
}

fn has_text(event: &LogEvent, wanted: &str) -> bool {
    matches!(event, LogEvent::Lines { lines } if lines.iter().any(|line| line.text == wanted))
}

#[tokio::test]
async fn reads_a_container_once_and_ends() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    pod_with_containers(&fake, json!({}));
    add_line(&fake, "main", ONE, "one");
    let (session, mut rx) = start(&core, &id, pod_target(Some("main")), once());
    let events = wait_until(&mut rx, is_last).await;
    let all = lines(&events);
    assert_eq!(all[0].text, "one");
    assert_eq!(all[0].timestamp.as_deref(), Some(ONE));
    assert_eq!(
        (all[0].pod.as_str(), all[0].container.as_str()),
        ("p", "main")
    );
    assert!(matches!(
        events.last(),
        Some(LogEvent::Ended {
            reason: LogEndReason::Completed
        })
    ));
    // Stopping a session that ended is safe.
    core.logs_stop(&session);
    assert!(core.sessions_wait_idle(LIMIT).await);
}

#[tokio::test]
async fn always_asks_for_timestamps_and_passes_the_options() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    pod_with_containers(&fake, json!({}));
    let options = LogOptions {
        follow: false,
        previous: true,
        tail_lines: Some(5),
        since_seconds: Some(60),
    };
    let (_session, mut rx) = start(&core, &id, pod_target(Some("main")), options);
    wait_until(&mut rx, is_last).await;
    let query = &fake.log_requests()[0];
    assert_eq!(query.get("timestamps").map(String::as_str), Some("true"));
    assert_eq!(query.get("previous").map(String::as_str), Some("true"));
    assert_eq!(query.get("tailLines").map(String::as_str), Some("5"));
    assert_eq!(query.get("sinceSeconds").map(String::as_str), Some("60"));
    assert_eq!(query.get("container").map(String::as_str), Some("main"));
}

#[tokio::test]
async fn a_null_container_reads_every_container_including_init() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    pod_with_containers(&fake, json!({}));
    add_line(&fake, "setup", ONE, "from init");
    add_line(&fake, "main", TWO, "from main");
    let (_session, mut rx) = start(&core, &id, pod_target(None), once());
    let events = wait_until(&mut rx, is_last).await;
    let mut seen = texts(&events);
    seen.sort();
    assert_eq!(seen, ["from init", "from main"]);
}

#[tokio::test]
async fn follow_delivers_new_lines_within_the_flush_time() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    pod_with_containers(&fake, json!({}));
    let (session, mut rx) = start(&core, &id, pod_target(Some("main")), follow());
    add_line(&fake, "main", ONE, "live");
    wait_until(&mut rx, |event| has_text(event, "live")).await;
    core.logs_stop(&session);
    let events = wait_until(&mut rx, is_last).await;
    assert!(matches!(
        events.last(),
        Some(LogEvent::Ended {
            reason: LogEndReason::Stopped
        })
    ));
    assert!(core.sessions_wait_idle(LIMIT).await);
}

#[tokio::test]
async fn stopping_all_ends_the_stream_at_the_api_server() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    pod_with_containers(&fake, json!({}));
    let (_session, mut rx) = start(&core, &id, pod_target(Some("main")), follow());
    add_line(&fake, "main", ONE, "live");
    wait_until(&mut rx, |event| has_text(event, "live")).await;
    assert_eq!(fake.open_log_count(), 1);
    core.sessions_stop_all();
    wait_until(&mut rx, is_last).await;
    assert!(core.sessions_wait_idle(LIMIT).await);
    tokio::time::timeout(LIMIT, async {
        while fake.open_log_count() != 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the API server stream stayed open");
}

#[tokio::test]
async fn disconnecting_the_cluster_stops_the_session() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    pod_with_containers(&fake, json!({}));
    let (_session, mut rx) = start(&core, &id, pod_target(Some("main")), follow());
    add_line(&fake, "main", ONE, "live");
    wait_until(&mut rx, |event| has_text(event, "live")).await;
    core.cluster_disconnect(&id).await.unwrap();
    let events = wait_until(&mut rx, is_last).await;
    assert!(matches!(
        events.last(),
        Some(LogEvent::Ended {
            reason: LogEndReason::Stopped
        })
    ));
}

#[tokio::test]
async fn dropping_the_receiver_stops_the_session() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    pod_with_containers(&fake, json!({}));
    let (_session, rx) = start(&core, &id, pod_target(Some("main")), follow());
    drop(rx);
    add_line(&fake, "main", ONE, "nobody reads this");
    assert!(core.sessions_wait_idle(LIMIT).await);
}

#[tokio::test]
async fn a_dropped_stream_resumes_and_sends_no_line_twice() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    pod_with_containers(
        &fake,
        json!({ "containerStatuses": [
        { "name": "main", "restartCount": 0, "state": { "running": {} } },
    ] }),
    );
    add_line(&fake, "main", ONE, "one");
    add_line(&fake, "main", TWO, "two");
    let (_session, mut rx) = start(&core, &id, pod_target(Some("main")), follow());
    let mut events = wait_until(&mut rx, |event| has_text(event, "two")).await;

    fake.end_log_streams("default", "p", "main");
    events.extend(wait_until(&mut rx, |event| has_marker(event, LogMarker::Reconnecting)).await);
    // The API server gives back the whole second, so `one` and `two` come again.
    add_line(&fake, "main", THREE, "three");
    events.extend(wait_until(&mut rx, |event| has_text(event, "three")).await);

    assert_eq!(texts(&events), ["one", "two", "three"]);
    assert!(events
        .iter()
        .any(|event| has_marker(event, LogMarker::Reconnecting)));
    assert!(events
        .iter()
        .any(|event| has_marker(event, LogMarker::Reconnected)));
    let resumed = fake.log_requests();
    let resume = resumed.last().unwrap();
    assert!(resume.get("sinceTime").is_some(), "{resume:?}");
    assert!(resume.get("tailLines").is_none(), "{resume:?}");
}

#[tokio::test]
async fn lines_with_the_same_timestamp_are_all_sent_and_not_repeated_after_a_resume() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    pod_with_containers(
        &fake,
        json!({ "containerStatuses": [
        { "name": "main", "restartCount": 0, "state": { "running": {} } },
    ] }),
    );
    add_line(&fake, "main", ONE, "a");
    add_line(&fake, "main", ONE, "b");
    let (_session, mut rx) = start(&core, &id, pod_target(Some("main")), follow());
    let mut events = wait_until(&mut rx, |event| has_text(event, "b")).await;

    fake.end_log_streams("default", "p", "main");
    events.extend(wait_until(&mut rx, |event| has_marker(event, LogMarker::Reconnecting)).await);
    add_line(&fake, "main", TWO, "c");
    add_line(&fake, "main", TWO, "d");
    events.extend(wait_until(&mut rx, |event| has_text(event, "d")).await);

    assert_eq!(texts(&events), ["a", "b", "c", "d"]);
}

#[tokio::test]
async fn a_quiet_stream_that_reopens_counts_as_reconnected() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    pod_with_containers(
        &fake,
        json!({ "containerStatuses": [
        { "name": "main", "restartCount": 0, "state": { "running": {} } },
    ] }),
    );
    let (_session, mut rx) = start(&core, &id, pod_target(Some("main")), follow());
    add_line(&fake, "main", ONE, "one");
    wait_until(&mut rx, |event| has_text(event, "one")).await;
    fake.end_log_streams("default", "p", "main");
    wait_until(&mut rx, |event| has_marker(event, LogMarker::Reconnected)).await;
}

#[tokio::test]
async fn a_restart_shows_a_marker_and_the_new_instance_follows() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    pod_with_containers(
        &fake,
        json!({ "containerStatuses": [
        { "name": "main", "restartCount": 0, "state": { "running": {} } },
    ] }),
    );
    let (_session, mut rx) = start(&core, &id, pod_target(Some("main")), follow());
    add_line(&fake, "main", ONE, "before");
    wait_until(&mut rx, |event| has_text(event, "before")).await;

    pod_with_containers(
        &fake,
        json!({ "containerStatuses": [
        { "name": "main", "restartCount": 1, "state": { "running": {} } },
    ] }),
    );
    fake.end_log_streams("default", "p", "main");
    wait_until(&mut rx, |event| has_marker(event, LogMarker::Restarted)).await;

    add_line(&fake, "main", TWO, "after");
    wait_until(&mut rx, |event| has_text(event, "after")).await;
}

#[tokio::test]
async fn a_replaced_pod_shows_a_marker_and_a_gone_pod_ends_the_session() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    pod_with_containers(&fake, json!({}));
    let (_session, mut rx) = start(&core, &id, pod_target(Some("main")), follow());
    add_line(&fake, "main", ONE, "first pod");
    wait_until(&mut rx, |event| has_text(event, "first pod")).await;

    // The same name with another uid, as a StatefulSet makes.
    fake.delete_pod("default", "p");
    fake.upsert(
        "pods",
        json!({
            "metadata": { "name": "p", "namespace": "default", "uid": "uid-2" },
            "spec": { "containers": [{ "name": "main" }] },
        }),
    );
    fake.end_log_streams("default", "p", "main");
    wait_until(&mut rx, |event| has_marker(event, LogMarker::Restarted)).await;

    fake.delete_pod("default", "p");
    fake.end_log_streams("default", "p", "main");
    let events = wait_until(&mut rx, is_last).await;
    assert!(matches!(
        events.last(),
        Some(LogEvent::Ended {
            reason: LogEndReason::PodGone
        })
    ));
}

#[tokio::test]
async fn a_container_that_finished_for_good_ends_the_session() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.upsert(
        "pods",
        json!({
            "metadata": { "name": "p", "namespace": "default" },
            "spec": { "restartPolicy": "Never", "containers": [{ "name": "main" }] },
            "status": { "containerStatuses": [
                { "name": "main", "restartCount": 0, "state": { "terminated": { "exitCode": 0 } } },
            ] },
        }),
    );
    let (_session, mut rx) = start(&core, &id, pod_target(Some("main")), follow());
    wait_for_open_stream(&fake).await;
    fake.end_log_streams("default", "p", "main");
    let events = wait_until(&mut rx, is_last).await;
    assert!(matches!(
        events.last(),
        Some(LogEvent::Ended {
            reason: LogEndReason::Completed
        })
    ));
}

#[tokio::test]
async fn a_missing_pod_is_a_failed_event_with_the_api_server_message() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    let (_session, mut rx) = start(&core, &id, pod_target(Some("main")), follow());
    let events = wait_until(&mut rx, is_last).await;
    let Some(LogEvent::Failed { error }) = events.last() else {
        panic!("{events:?}");
    };
    assert_eq!(error.code, ErrorCode::NotFound);
    assert!(error.message.contains("\"p\""), "{}", error.message);
}

#[tokio::test]
async fn forbidden_on_one_container_is_a_marker_and_the_others_continue() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    pod_with_containers(&fake, json!({}));
    fake.fail_logs_with("default", "p", "setup", Some(403));
    add_line(&fake, "main", ONE, "still here");
    let (session, mut rx) = start(&core, &id, pod_target(None), follow());
    let mut events = wait_until(&mut rx, |event| has_marker(event, LogMarker::Failed)).await;
    if !events.iter().any(|event| has_text(event, "still here")) {
        events.extend(wait_until(&mut rx, |event| has_text(event, "still here")).await);
    }
    let failed = events
        .iter()
        .find(|event| has_marker(event, LogMarker::Failed));
    let Some(LogEvent::Marker {
        container, message, ..
    }) = failed
    else {
        panic!("{events:?}");
    };
    assert_eq!(container.as_deref(), Some("setup"));
    assert!(message.as_deref().is_some_and(|m| m.contains("403")));
    core.logs_stop(&session);
}

#[tokio::test]
async fn forbidden_on_the_only_container_is_final() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    pod_with_containers(&fake, json!({}));
    fake.fail_logs_with("default", "p", "main", Some(403));
    let (_session, mut rx) = start(&core, &id, pod_target(Some("main")), follow());
    let events = wait_until(&mut rx, is_last).await;
    let Some(LogEvent::Failed { error }) = events.last() else {
        panic!("{events:?}");
    };
    assert_eq!(error.code, ErrorCode::Forbidden);
}

#[tokio::test]
async fn a_container_not_started_yet_is_retried_and_says_why_once() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    pod_with_containers(&fake, json!({}));
    fake.fail_logs_with("default", "p", "main", Some(400));
    let (session, mut rx) = start(&core, &id, pod_target(Some("main")), follow());
    let events = wait_until(&mut rx, |event| has_marker(event, LogMarker::Reconnecting)).await;
    let Some(LogEvent::Marker { message, .. }) = events.last() else {
        panic!("{events:?}");
    };
    assert!(message.is_some(), "{events:?}");
    tokio::time::sleep(Duration::from_millis(300)).await;
    fake.fail_logs_with("default", "p", "main", None);
    add_line(&fake, "main", ONE, "started");
    let events = wait_until(&mut rx, |event| has_text(event, "started")).await;
    // The reason was given once, not on every retry.
    assert!(!events
        .iter()
        .any(|event| has_marker(event, LogMarker::Reconnecting)));
    // The first line after the failure ends it.
    assert!(events
        .iter()
        .any(|event| has_marker(event, LogMarker::Reconnected)));
    core.logs_stop(&session);
}

#[tokio::test]
async fn a_workload_watch_that_fails_shows_a_marker_and_recovers() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    add_deployment(&fake);
    add_web_pod(&fake, "web-1", "web");
    fake.fail_watches_with("pods", Some(500));
    let (session, mut rx) = start(&core, &id, deployment_target(), follow());
    let events = wait_until(&mut rx, |event| has_marker(event, LogMarker::Reconnecting)).await;
    let Some(LogEvent::Marker {
        pod,
        container,
        message,
        ..
    }) = events.last()
    else {
        panic!("{events:?}");
    };
    assert_eq!(pod, "web");
    assert!(container.is_none());
    assert!(message.is_some());
    fake.fail_watches_with("pods", None);
    wait_until(&mut rx, |event| has_marker(event, LogMarker::Reconnected)).await;
    core.logs_stop(&session);
}

#[tokio::test]
async fn a_flood_arrives_whole_and_in_order() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    pod_with_containers(&fake, json!({}));
    let total = 12_000;
    let flood: Vec<FakeLogLine> = (0..total)
        .map(|number| {
            FakeLogLine::new(
                &format!("2026-01-01T00:00:01.{number:09}Z"),
                &number.to_string(),
            )
        })
        .collect();
    fake.add_log_lines("default", "p", "main", &flood);
    let (_session, mut rx) = start(&core, &id, pod_target(Some("main")), once());
    let events = wait_until(&mut rx, is_last).await;
    let seen = texts(&events);
    assert_eq!(seen.len(), total);
    assert!(seen
        .iter()
        .enumerate()
        .all(|(index, text)| text == &index.to_string()));
    for event in &events {
        if let LogEvent::Lines { lines } = event {
            assert!(lines.len() <= 5_000);
        }
    }
}

#[tokio::test]
async fn bad_arguments_and_a_disconnected_cluster_are_refused_at_once() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    pod_with_containers(&fake, json!({}));
    let (tx, _rx) = mpsc::channel(4);
    let bad = LogTarget::Pod {
        namespace: "default".into(),
        pod: "a/b".into(),
        container: None,
    };
    let error = core.logs_start(&id, bad, once(), tx.clone()).unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);

    core.cluster_disconnect(&id).await.unwrap();
    let error = core
        .logs_start(&id, pod_target(None), once(), tx)
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Unreachable);
    assert_eq!(core.session_count(), 0);
}

#[tokio::test]
async fn the_page_load_stop_leaves_the_connection_usable() {
    // The `on_page_load` hook has no automated coverage. This pins what it calls.
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    pod_with_containers(&fake, json!({}));
    let (_first, mut first_rx) = start(&core, &id, pod_target(Some("main")), follow());
    let (_second, mut second_rx) = start(&core, &id, pod_target(Some("setup")), follow());
    core.sessions_stop_all();
    wait_until(&mut first_rx, is_last).await;
    wait_until(&mut second_rx, is_last).await;
    assert!(core.sessions_wait_idle(LIMIT).await);
    let (_again, mut rx) = start(&core, &id, pod_target(Some("main")), once());
    wait_until(&mut rx, is_last).await;
}

fn deployment_target() -> LogTarget {
    LogTarget::Workload {
        resource: ResourceRef {
            group: "apps".into(),
            version: "v1".into(),
            plural: "deployments".into(),
            kind: "Deployment".into(),
            namespaced: true,
        },
        namespace: "default".into(),
        name: "web".into(),
        container: None,
    }
}

fn add_deployment(fake: &FakeKube) {
    fake.upsert(
        "deployments",
        json!({
            "metadata": { "name": "web", "namespace": "default" },
            "spec": { "selector": { "matchLabels": { "app": "web" } } },
        }),
    );
}

fn add_web_pod(fake: &FakeKube, name: &str, app: &str) {
    fake.upsert(
        "pods",
        json!({
            "metadata": { "name": name, "namespace": "default", "labels": { "app": app } },
            "spec": { "containers": [{ "name": "main" }] },
        }),
    );
}

fn add_pod_line(fake: &FakeKube, pod: &str, stamp: &str, text: &str) {
    fake.add_log_lines("default", pod, "main", &[FakeLogLine::new(stamp, text)]);
}

#[tokio::test]
async fn a_workload_reads_the_pods_its_selector_picks() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    add_deployment(&fake);
    add_web_pod(&fake, "web-1", "web");
    add_web_pod(&fake, "web-2", "web");
    add_web_pod(&fake, "other", "other");
    add_pod_line(&fake, "web-1", ONE, "from one");
    add_pod_line(&fake, "web-2", TWO, "from two");
    add_pod_line(&fake, "other", THREE, "not selected");
    let (_session, mut rx) = start(&core, &id, deployment_target(), once());
    let events = wait_until(&mut rx, is_last).await;
    let mut seen = texts(&events);
    seen.sort();
    assert_eq!(seen, ["from one", "from two"]);
    assert!(matches!(
        events.last(),
        Some(LogEvent::Ended {
            reason: LogEndReason::Completed
        })
    ));
}

#[tokio::test]
async fn following_a_workload_adds_and_removes_pods_as_they_come_and_go() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    add_deployment(&fake);
    add_web_pod(&fake, "web-1", "web");
    add_pod_line(&fake, "web-1", ONE, "from one");
    let (session, mut rx) = start(&core, &id, deployment_target(), follow());
    let first = wait_until(&mut rx, |event| has_text(event, "from one")).await;
    // A pod there from the start is not news.
    assert!(!first
        .iter()
        .any(|event| has_marker(event, LogMarker::PodAdded)));

    add_web_pod(&fake, "web-2", "web");
    wait_until(&mut rx, |event| has_marker(event, LogMarker::PodAdded)).await;
    add_pod_line(&fake, "web-2", TWO, "from two");
    wait_until(&mut rx, |event| has_text(event, "from two")).await;

    fake.delete_pod("default", "web-1");
    let removed = wait_until(&mut rx, |event| has_marker(event, LogMarker::PodRemoved)).await;
    let Some(LogEvent::Marker { pod, .. }) = removed.last() else {
        panic!("{removed:?}");
    };
    assert_eq!(pod, "web-1");

    core.logs_stop(&session);
    let events = wait_until(&mut rx, is_last).await;
    assert!(matches!(
        events.last(),
        Some(LogEvent::Ended {
            reason: LogEndReason::Stopped
        })
    ));
    assert!(core.sessions_wait_idle(LIMIT).await);
}

#[tokio::test]
async fn one_failed_stream_of_a_workload_leaves_the_others_running() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    add_deployment(&fake);
    add_web_pod(&fake, "web-1", "web");
    add_web_pod(&fake, "web-2", "web");
    fake.fail_logs_with("default", "web-1", "main", Some(403));
    let (session, mut rx) = start(&core, &id, deployment_target(), follow());
    let failed = wait_until(&mut rx, |event| has_marker(event, LogMarker::Failed)).await;
    let Some(LogEvent::Marker { pod, .. }) = failed.last() else {
        panic!("{failed:?}");
    };
    assert_eq!(pod, "web-1");
    add_pod_line(&fake, "web-2", ONE, "still here");
    wait_until(&mut rx, |event| has_text(event, "still here")).await;
    core.logs_stop(&session);
}

#[tokio::test]
async fn a_forbidden_pod_watch_ends_the_session() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig {
        deny: vec![DenyRule {
            verb: "list".into(),
            plural: "pods".into(),
            namespace: Some("default".into()),
        }],
        ..FakeKubeConfig::default()
    })
    .await;
    add_deployment(&fake);
    let (_session, mut rx) = start(&core, &id, deployment_target(), follow());
    let events = wait_until(&mut rx, is_last).await;
    let Some(LogEvent::Failed { error }) = events.last() else {
        panic!("{events:?}");
    };
    assert_eq!(error.code, ErrorCode::Forbidden);
}

#[tokio::test]
async fn a_kind_without_pods_of_its_own_is_refused() {
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    let (tx, _rx) = mpsc::channel(4);
    let target = LogTarget::Workload {
        resource: ResourceRef {
            group: "batch".into(),
            version: "v1".into(),
            plural: "cronjobs".into(),
            kind: "CronJob".into(),
            namespaced: true,
        },
        namespace: "default".into(),
        name: "c".into(),
        container: None,
    };
    let error = core.logs_start(&id, target, once(), tx).unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
}

#[tokio::test]
async fn a_workload_without_a_usable_selector_is_a_failed_event() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    fake.upsert(
        "deployments",
        json!({ "metadata": { "name": "web", "namespace": "default" }, "spec": { "selector": {} } }),
    );
    let (_session, mut rx) = start(&core, &id, deployment_target(), follow());
    let events = wait_until(&mut rx, is_last).await;
    let Some(LogEvent::Failed { error }) = events.last() else {
        panic!("{events:?}");
    };
    assert_eq!(error.code, ErrorCode::InvalidInput);
}
#[tokio::test]
async fn a_download_writes_every_line_past_the_tail_limit() {
    let (core, fake, id, root) = connected_fake(FakeKubeConfig::default()).await;
    pod_with_containers(&fake, json!({}));
    add_line(&fake, "main", ONE, "one");
    add_line(&fake, "main", TWO, "two");
    let dest = root.path().join("saved.log");
    let options = LogOptions {
        tail_lines: Some(1),
        follow: true,
        ..once()
    };
    let saved = core
        .logs_download(&id, pod_target(Some("main")), options, &dest)
        .await
        .unwrap();
    let text = std::fs::read_to_string(&dest).unwrap();
    assert_eq!(text, format!("{ONE} one\n{TWO} two\n"));
    assert_eq!(saved.bytes, text.len() as u64);
    assert_eq!(fake.log_requests()[0].get("follow"), None);
    assert_eq!(core.session_count(), 0);
}

#[tokio::test]
async fn a_download_of_several_streams_labels_lines_and_notes_a_failure() {
    let (core, fake, id, root) = connected_fake(FakeKubeConfig::default()).await;
    pod_with_containers(&fake, json!({}));
    fake.fail_logs_with("default", "p", "setup", Some(403));
    add_line(&fake, "main", ONE, "one");
    let dest = root.path().join("saved.log");
    core.logs_download(&id, pod_target(None), once(), &dest)
        .await
        .unwrap();
    let text = std::fs::read_to_string(&dest).unwrap();
    assert!(text.contains(&format!("[p/main] {ONE} one\n")), "{text}");
    assert!(text.contains("[p/setup] "), "{text}");
}

#[tokio::test]
async fn a_failed_download_rejects_and_leaves_no_file() {
    let (core, fake, id, root) = connected_fake(FakeKubeConfig::default()).await;
    pod_with_containers(&fake, json!({}));
    fake.fail_logs_with("default", "p", "main", Some(403));
    let dest = root.path().join("saved.log");
    let error = core
        .logs_download(&id, pod_target(Some("main")), once(), &dest)
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Forbidden);
    assert!(!dest.exists());
    let leftovers = std::fs::read_dir(root.path())
        .unwrap()
        .filter(|entry| {
            let name = entry.as_ref().unwrap().file_name();
            name.to_string_lossy().starts_with(".tmp")
        })
        .count();
    assert_eq!(leftovers, 0);
}

#[tokio::test]
async fn a_download_refuses_a_relative_path() {
    let (core, fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    pod_with_containers(&fake, json!({}));
    let error = core
        .logs_download(
            &id,
            pod_target(Some("main")),
            once(),
            std::path::Path::new("saved.log"),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
}

#[tokio::test]
async fn an_unwritable_download_folder_is_refused_without_quoting_it() {
    let (core, fake, id, root) = connected_fake(FakeKubeConfig::default()).await;
    pod_with_containers(&fake, json!({}));
    let dest = root.path().join("missing-folder").join("saved.log");
    let error = core
        .logs_download(&id, pod_target(Some("main")), once(), &dest)
        .await
        .unwrap_err();
    let shown = format!("{} {:?}", error.message, error.details);
    assert!(!shown.contains("missing-folder"), "{shown}");
    assert!(!shown.contains(root.path().to_str().unwrap()), "{shown}");
}
