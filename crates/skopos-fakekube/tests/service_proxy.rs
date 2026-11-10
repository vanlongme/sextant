//! The fake's service proxy, reached through the real `kube` client.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use axum::http::{header, Request};
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{Client, Config};
use serde_json::{json, Value};
use skopos_fakekube::{DenyRule, FakeKube, FakeKubeConfig, ProxyReply, ProxyRequest};

const PROXY: &str = "/api/v1/namespaces/monitoring/services/prom:9090/proxy";

async fn client(fake: &FakeKube, dir: &std::path::Path) -> Client {
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
    Client::try_from(config).unwrap()
}

fn up(_: &ProxyRequest) -> ProxyReply {
    ProxyReply::json(
        200,
        json!({ "status": "success", "data": { "resultType": "vector", "result": [] } }),
    )
}

fn get(path: &str) -> Request<Vec<u8>> {
    Request::get(path).body(Vec::new()).unwrap()
}

fn form_post(path: &str, body: &str) -> Request<Vec<u8>> {
    Request::post(path)
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(body.as_bytes().to_vec())
        .unwrap()
}

fn params(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
        .collect()
}

#[tokio::test]
async fn a_served_service_answers_get_and_form_post_and_records_both() {
    let fake = FakeKube::start(FakeKubeConfig::default()).await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let client = client(&fake, dir.path()).await;
    fake.serve_proxy("monitoring", "prom:9090", up);

    let text = client
        .request_text(get(&format!("{PROXY}/api/v1/query?query=up&time=60")))
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&text).unwrap()["status"],
        "success"
    );
    client
        .request_text(form_post(
            &format!("{PROXY}/api/v1/query_range"),
            "query=sum%28up%29&step=60",
        ))
        .await
        .unwrap();

    let requests = fake.proxy_requests("monitoring", "prom:9090");
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].method, "GET");
    assert_eq!(requests[0].path, "/api/v1/query");
    assert_eq!(
        requests[0].params,
        params(&[("query", "up"), ("time", "60")])
    );
    assert_eq!(requests[1].method, "POST");
    assert_eq!(requests[1].path, "/api/v1/query_range");
    assert_eq!(
        requests[1].params,
        params(&[("query", "sum(up)"), ("step", "60")])
    );
    assert_eq!(
        requests[1].content_type.as_deref(),
        Some("application/x-www-form-urlencoded")
    );
}

#[tokio::test]
async fn a_service_nobody_serves_is_not_found_and_still_recorded() {
    let fake = FakeKube::start(FakeKubeConfig::default()).await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let client = client(&fake, dir.path()).await;

    let err = client
        .request_text(get(&format!("{PROXY}/api/v1/query?query=up")))
        .await
        .unwrap_err();
    assert!(
        matches!(err, kube::Error::Api(ref status) if status.code == 404),
        "{err:?}"
    );
    assert_eq!(fake.proxy_requests("monitoring", "prom:9090").len(), 1);
    assert!(fake.proxy_requests("monitoring", "other:9090").is_empty());
}

#[tokio::test]
async fn proxy_rights_are_checked_per_verb() {
    let fake = FakeKube::start(FakeKubeConfig {
        deny: vec![DenyRule {
            verb: "get".into(),
            plural: "services/proxy".into(),
            namespace: Some("monitoring".into()),
        }],
        ..Default::default()
    })
    .await
    .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let client = client(&fake, dir.path()).await;
    fake.serve_proxy("monitoring", "prom:9090", up);

    let err = client
        .request_text(get(&format!("{PROXY}/api/v1/query?query=up")))
        .await
        .unwrap_err();
    assert!(
        matches!(err, kube::Error::Api(ref status) if status.code == 403),
        "{err:?}"
    );
    client
        .request_text(form_post(&format!("{PROXY}/api/v1/query"), "query=up"))
        .await
        .unwrap();
    // A refused request never reaches the Service.
    let requests = fake.proxy_requests("monitoring", "prom:9090");
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, "POST");
}

#[tokio::test]
async fn a_reply_can_wait_before_answering() {
    let fake = FakeKube::start(FakeKubeConfig::default()).await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let client = client(&fake, dir.path()).await;
    fake.serve_proxy("monitoring", "prom:9090", |_| {
        ProxyReply::text(503, "no endpoints available for service \"prom\"")
            .after(Duration::from_millis(300))
    });

    let started = Instant::now();
    let err = client
        .request_text(get(&format!("{PROXY}/api/v1/query?query=up")))
        .await
        .unwrap_err();
    assert!(started.elapsed() >= Duration::from_millis(300));
    assert!(
        matches!(err, kube::Error::Api(ref status) if status.code == 503),
        "{err:?}"
    );
}
