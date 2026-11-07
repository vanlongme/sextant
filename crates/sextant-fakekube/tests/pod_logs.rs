//! The fake's `log` subresource, read through the real `kube` client.

use futures::{AsyncBufReadExt, TryStreamExt};
use k8s_openapi::api::core::v1::Pod;
use kube::api::LogParams;
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{Api, Client, Config};
use serde_json::json;
use sextant_fakekube::{FakeKube, FakeKubeConfig, FakeLogLine};

const FIRST: &str = "2026-01-01T00:00:01.000000001Z";
const SECOND: &str = "2026-01-01T00:00:01.000000002Z";
const THIRD: &str = "2026-01-01T00:00:02.000000001Z";

async fn pods_api(fake: &FakeKube, dir: &std::path::Path) -> Api<Pod> {
    let path = dir.join("config");
    fake.write_kubeconfig(&path, "fake").unwrap();
    let kubeconfig = Kubeconfig::read_from(&path).unwrap();
    let options = KubeConfigOptions {
        context: Some("fake".into()),
        ..Default::default()
    };
    let config = Config::from_custom_kubeconfig(kubeconfig, &options)
        .await
        .unwrap();
    Api::namespaced(Client::try_from(config).unwrap(), "default")
}

fn params() -> LogParams {
    LogParams {
        container: Some("main".to_owned()),
        timestamps: true,
        ..Default::default()
    }
}

async fn fake_with_lines() -> (FakeKube, tempfile::TempDir, Api<Pod>) {
    let fake = FakeKube::start(FakeKubeConfig::default()).await.unwrap();
    fake.add_pod("default", "p");
    fake.add_log_lines(
        "default",
        "p",
        "main",
        &[
            FakeLogLine::new(FIRST, "one"),
            FakeLogLine::new(SECOND, "two"),
            FakeLogLine::new(THIRD, "three"),
        ],
    );
    let dir = tempfile::tempdir().unwrap();
    let pods = pods_api(&fake, dir.path()).await;
    (fake, dir, pods)
}

#[tokio::test]
async fn serves_lines_with_and_without_timestamps() {
    let (_fake, _dir, pods) = fake_with_lines().await;
    let plain = LogParams {
        timestamps: false,
        ..params()
    };
    assert_eq!(pods.logs("p", &plain).await.unwrap(), "one\ntwo\nthree\n");
    let stamped = pods.logs("p", &params()).await.unwrap();
    assert!(stamped.starts_with(&format!("{FIRST} one\n")));
}

#[tokio::test]
async fn tail_lines_keeps_the_last_ones() {
    let (_fake, _dir, pods) = fake_with_lines().await;
    let tail = LogParams {
        timestamps: false,
        tail_lines: Some(1),
        ..params()
    };
    assert_eq!(pods.logs("p", &tail).await.unwrap(), "three\n");
}

#[tokio::test]
async fn since_time_works_in_whole_seconds_as_a_real_api_server_does() {
    let (_fake, _dir, pods) = fake_with_lines().await;
    let since = LogParams {
        timestamps: false,
        since_time: Some(SECOND.parse().unwrap()),
        ..params()
    };
    // `one` is in the same second as `two`, so it comes back too.
    assert_eq!(pods.logs("p", &since).await.unwrap(), "one\ntwo\nthree\n");
}

#[tokio::test]
async fn follow_streams_new_lines_until_ended() {
    let (fake, _dir, pods) = fake_with_lines().await;
    let follow = LogParams {
        timestamps: false,
        follow: true,
        ..params()
    };
    let mut lines = pods.log_stream("p", &follow).await.unwrap().lines();
    for expected in ["one", "two", "three"] {
        assert_eq!(lines.try_next().await.unwrap().as_deref(), Some(expected));
    }
    assert_eq!(fake.open_log_count(), 1);
    fake.add_log_lines("default", "p", "main", &[FakeLogLine::new(THIRD, "four")]);
    assert_eq!(lines.try_next().await.unwrap().as_deref(), Some("four"));
    fake.end_log_streams("default", "p", "main");
    assert_eq!(lines.try_next().await.unwrap(), None);
    drop(lines);
    assert_eq!(fake.open_log_count(), 0);
}

#[tokio::test]
async fn errors_look_like_a_real_api_server() {
    let (fake, _dir, pods) = fake_with_lines().await;
    let code = |error: kube::Error| match error {
        kube::Error::Api(status) => status.code,
        other => panic!("{other:?}"),
    };
    assert_eq!(
        code(pods.logs("missing", &params()).await.unwrap_err()),
        404
    );
    let wrong = LogParams {
        container: Some("other".to_owned()),
        ..params()
    };
    assert_eq!(code(pods.logs("p", &wrong).await.unwrap_err()), 400);

    fake.fail_logs_with("default", "p", "main", Some(403));
    assert_eq!(code(pods.logs("p", &params()).await.unwrap_err()), 403);
    fake.fail_logs_with("default", "p", "main", None);
    assert!(pods.logs("p", &params()).await.is_ok());

    fake.upsert(
        "pods",
        json!({
            "metadata": { "name": "two", "namespace": "default" },
            "spec": { "containers": [{ "name": "a" }, { "name": "b" }] },
        }),
    );
    let unnamed = LogParams::default();
    assert_eq!(code(pods.logs("two", &unnamed).await.unwrap_err()), 400);
    assert_eq!(fake.log_requests().len(), 5);
}
