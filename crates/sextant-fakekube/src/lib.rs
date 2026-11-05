//! A fake Kubernetes API server for tests. It speaks just enough of the API
//! for a real `kube` client to connect, discover, list and watch.

pub mod discovery;

use std::collections::{BTreeMap, VecDeque};
use std::convert::Infallible;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::{Path as UrlPath, Query, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use tokio::sync::broadcast;
use tokio::task::JoinHandle;

#[derive(Clone, Default)]
pub struct FakeKubeConfig {
    /// Every request gets 401.
    pub unauthorized: bool,
    /// Sleep before answering /version.
    pub version_delay: Duration,
    /// GET /api/v1/namespaces gets 403.
    pub forbid_namespace_list: bool,
    /// GET /api/v1/pods gets 403; namespaced still works.
    pub forbid_cluster_wide_pods: bool,
    /// SelfSubjectAccessReview returns allowed=false.
    pub deny_all_access_reviews: bool,
    /// Defaults to ["default", "kube-system"] when empty.
    pub namespaces: Vec<String>,
    /// Defaults to "v1.37.0".
    pub git_version: Option<String>,
    /// Discovery answers in the legacy format even when asked for the aggregated one.
    pub no_aggregated_discovery: bool,
}

#[derive(Clone)]
struct WatchEvent {
    rv: u64,
    namespace: String,
    kind: &'static str,
    pod: Value,
}

struct State_ {
    rv: u64,
    pods: BTreeMap<(String, String), Value>,
    history: Vec<WatchEvent>,
    counts: BTreeMap<String, usize>,
}

struct Inner {
    cfg: FakeKubeConfig,
    state: Mutex<State_>,
    events: broadcast::Sender<WatchEvent>,
    drop_watches: broadcast::Sender<()>,
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, State_> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
}

type Shared = Arc<Inner>;

pub struct FakeKube {
    inner: Shared,
    addr: SocketAddr,
    task: JoinHandle<()>,
}

impl FakeKube {
    pub async fn start(cfg: FakeKubeConfig) -> anyhow::Result<FakeKube> {
        let (events, _) = broadcast::channel(1024);
        let (drop_watches, _) = broadcast::channel(16);
        let inner = Arc::new(Inner {
            cfg,
            state: Mutex::new(State_ {
                rv: 100,
                pods: BTreeMap::new(),
                history: Vec::new(),
                counts: BTreeMap::new(),
            }),
            events,
            drop_watches,
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;
        let app = router(inner.clone());
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Ok(FakeKube { inner, addr, task })
    }

    pub fn url(&self) -> String {
        format!("http://{}", self.addr)
    }

    pub fn write_kubeconfig(&self, path: &Path, context: &str) -> anyhow::Result<()> {
        let doc = json!({
            "apiVersion": "v1",
            "kind": "Config",
            "current-context": context,
            "clusters": [{ "name": context, "cluster": { "server": self.url() } }],
            "users": [{ "name": context, "user": { "token": "fake-token" } }],
            "contexts": [{ "name": context, "context": { "cluster": context, "user": context } }],
        });
        // JSON is valid YAML, so the kubeconfig parser accepts it.
        std::fs::write(path, serde_json::to_vec_pretty(&doc)?)?;
        Ok(())
    }

    /// Adds a pod and emits a watch ADDED event.
    pub fn add_pod(&self, namespace: &str, name: &str) {
        let mut st = self.inner.lock();
        st.rv += 1;
        let rv = st.rv;
        let pod = pod_json(namespace, name, rv);
        st.pods
            .insert((namespace.to_string(), name.to_string()), pod.clone());
        self.emit(&mut st, rv, namespace, "ADDED", pod);
    }

    /// Removes a pod and emits a watch DELETED event.
    pub fn delete_pod(&self, namespace: &str, name: &str) {
        let mut st = self.inner.lock();
        let Some(mut pod) = st.pods.remove(&(namespace.to_string(), name.to_string())) else {
            return;
        };
        st.rv += 1;
        let rv = st.rv;
        pod["metadata"]["resourceVersion"] = json!(rv.to_string());
        self.emit(&mut st, rv, namespace, "DELETED", pod);
    }

    fn emit(&self, st: &mut State_, rv: u64, namespace: &str, kind: &'static str, pod: Value) {
        let ev = WatchEvent {
            rv,
            namespace: namespace.to_string(),
            kind,
            pod,
        };
        st.history.push(ev.clone());
        // No receivers is fine.
        let _ = self.inner.events.send(ev);
    }

    /// Closes open watch streams.
    pub fn drop_watches(&self) {
        let _ = self.inner.drop_watches.send(());
    }

    pub fn request_count(&self, path: &str) -> usize {
        self.inner.lock().counts.get(path).copied().unwrap_or(0)
    }

    pub async fn shutdown(self) {
        self.task.abort();
    }
}

impl Drop for FakeKube {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn pod_json(namespace: &str, name: &str, rv: u64) -> Value {
    json!({
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {
            "name": name,
            "namespace": namespace,
            "uid": format!("uid-{namespace}-{name}"),
            "resourceVersion": rv.to_string(),
            "creationTimestamp": "2026-01-01T00:00:00Z",
        },
        "spec": { "containers": [{ "name": "main", "image": "registry.k8s.io/pause:3.10" }] },
        "status": { "phase": "Running" },
    })
}

fn status(code: u16, reason: &str, message: &str) -> Response {
    let body = json!({
        "kind": "Status",
        "apiVersion": "v1",
        "metadata": {},
        "status": "Failure",
        "message": message,
        "reason": reason,
        "code": code,
    });
    let mut resp = (
        StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        Json(body),
    )
        .into_response();
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    resp
}

fn json_ok(v: Value) -> Response {
    ([(header::CONTENT_TYPE, "application/json")], v.to_string()).into_response()
}

fn router(inner: Shared) -> Router {
    Router::new()
        .route("/version", get(version))
        .route("/api", get(api))
        .route("/apis", get(apis))
        .route(
            "/api/v1",
            get(|| async { json_ok(discovery::core_v1_resources()) }),
        )
        .route(
            "/apis/apps/v1",
            get(|| async { json_ok(discovery::apps_v1_resources()) }),
        )
        .route(
            "/apis/authorization.k8s.io/v1",
            get(|| async { json_ok(discovery::authz_v1_resources()) }),
        )
        .route("/api/v1/namespaces", get(namespaces))
        .route("/api/v1/pods", get(pods_all))
        .route("/api/v1/namespaces/{ns}/pods", get(pods_namespaced))
        .route(
            "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews",
            post(access_review),
        )
        .fallback(|| async {
            status(
                404,
                "NotFound",
                "the server could not find the requested resource",
            )
        })
        .layer(middleware::from_fn_with_state(
            inner.clone(),
            count_and_auth,
        ))
        .with_state(inner)
}

async fn count_and_auth(State(s): State<Shared>, req: Request, next: Next) -> Response {
    {
        let mut st = s.lock();
        *st.counts.entry(req.uri().path().to_string()).or_insert(0) += 1;
    }
    if s.cfg.unauthorized {
        return status(401, "Unauthorized", "Unauthorized");
    }
    next.run(req).await
}

async fn version(State(s): State<Shared>) -> Response {
    if !s.cfg.version_delay.is_zero() {
        tokio::time::sleep(s.cfg.version_delay).await;
    }
    let git = s
        .cfg
        .git_version
        .clone()
        .unwrap_or_else(|| "v1.37.0".to_string());
    let minor = git
        .trim_start_matches('v')
        .split('.')
        .nth(1)
        .unwrap_or("37")
        .to_string();
    json_ok(json!({
        "major": "1",
        "minor": minor,
        "gitVersion": git,
        "gitCommit": "fake",
        "gitTreeState": "clean",
        "buildDate": "2026-01-01T00:00:00Z",
        "goVersion": "go1.25",
        "compiler": "gc",
        "platform": "linux/amd64",
    }))
}

fn wants_aggregated(h: &HeaderMap) -> bool {
    h.get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.contains("as=APIGroupDiscoveryList"))
}

fn aggregated(v: Value) -> Response {
    (
        [(header::CONTENT_TYPE, discovery::AGGREGATED_CONTENT_TYPE)],
        v.to_string(),
    )
        .into_response()
}

async fn api(State(s): State<Shared>, headers: HeaderMap) -> Response {
    if !s.cfg.no_aggregated_discovery && wants_aggregated(&headers) {
        aggregated(discovery::aggregated_core())
    } else {
        json_ok(discovery::legacy_api_versions())
    }
}

async fn apis(State(s): State<Shared>, headers: HeaderMap) -> Response {
    if !s.cfg.no_aggregated_discovery && wants_aggregated(&headers) {
        aggregated(discovery::aggregated_apis())
    } else {
        json_ok(discovery::legacy_api_group_list())
    }
}

async fn namespaces(State(s): State<Shared>) -> Response {
    if s.cfg.forbid_namespace_list {
        return status(
            403,
            "Forbidden",
            "namespaces is forbidden: User \"fake\" cannot list resource \"namespaces\" in API group \"\" at the cluster scope",
        );
    }
    let names: Vec<String> = if s.cfg.namespaces.is_empty() {
        vec!["default".into(), "kube-system".into()]
    } else {
        s.cfg.namespaces.clone()
    };
    let rv = s.lock().rv;
    let items: Vec<Value> = names
        .iter()
        .map(|n| {
            json!({
                "apiVersion": "v1",
                "kind": "Namespace",
                "metadata": {
                    "name": n,
                    "uid": format!("uid-ns-{n}"),
                    "resourceVersion": "1",
                    "creationTimestamp": "2026-01-01T00:00:00Z",
                },
                "spec": {},
                "status": { "phase": "Active" },
            })
        })
        .collect();
    json_ok(json!({
        "apiVersion": "v1",
        "kind": "NamespaceList",
        "metadata": { "resourceVersion": rv.to_string() },
        "items": items,
    }))
}

type Params = Query<BTreeMap<String, String>>;

async fn pods_all(State(s): State<Shared>, Query(q): Params) -> Response {
    if s.cfg.forbid_cluster_wide_pods {
        return status(
            403,
            "Forbidden",
            "pods is forbidden: User \"fake\" cannot list resource \"pods\" in API group \"\" at the cluster scope",
        );
    }
    pods(s, None, q)
}

async fn pods_namespaced(
    State(s): State<Shared>,
    UrlPath(ns): UrlPath<String>,
    Query(q): Params,
) -> Response {
    pods(s, Some(ns), q)
}

fn pods(s: Shared, ns: Option<String>, q: BTreeMap<String, String>) -> Response {
    let watch = q.get("watch").is_some_and(|v| v == "true" || v == "1");
    if watch {
        return watch_pods(s, ns, q.get("resourceVersion").and_then(|v| v.parse().ok()));
    }
    let st = s.lock();
    let items: Vec<Value> = st
        .pods
        .iter()
        .filter(|((pns, _), _)| ns.as_deref().is_none_or(|n| n == pns))
        .map(|(_, p)| p.clone())
        .collect();
    json_ok(json!({
        "apiVersion": "v1",
        "kind": "PodList",
        "metadata": { "resourceVersion": st.rv.to_string() },
        "items": items,
    }))
}

struct WatchState {
    backlog: VecDeque<WatchEvent>,
    rx: broadcast::Receiver<WatchEvent>,
    stop: broadcast::Receiver<()>,
    ns: Option<String>,
    last_rv: u64,
}

fn watch_pods(s: Shared, ns: Option<String>, since: Option<u64>) -> Response {
    // Subscribe and snapshot history under one lock so no event is missed or duplicated.
    let (backlog, rx, stop, since) = {
        let st = s.lock();
        let since = since.unwrap_or(st.rv);
        let backlog: VecDeque<WatchEvent> = st
            .history
            .iter()
            .filter(|e| e.rv > since)
            .cloned()
            .collect();
        (
            backlog,
            s.events.subscribe(),
            s.drop_watches.subscribe(),
            since,
        )
    };
    let state = WatchState {
        backlog,
        rx,
        stop,
        ns,
        last_rv: since,
    };
    let stream = futures::stream::unfold(state, |mut w| async move {
        loop {
            let ev = if let Some(ev) = w.backlog.pop_front() {
                ev
            } else {
                tokio::select! {
                    _ = w.stop.recv() => return None,
                    r = w.rx.recv() => match r {
                        Ok(ev) => ev,
                        Err(_) => return None,
                    },
                }
            };
            if ev.rv <= w.last_rv || w.ns.as_deref().is_some_and(|n| n != ev.namespace) {
                continue;
            }
            w.last_rv = ev.rv;
            let mut line = json!({ "type": ev.kind, "object": ev.pod }).to_string();
            line.push('\n');
            return Some((Ok::<Bytes, Infallible>(Bytes::from(line)), w));
        }
    });
    let mut resp = Response::new(Body::from_stream(stream));
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    resp
}

async fn access_review(State(s): State<Shared>, Json(mut review): Json<Value>) -> Response {
    review["status"] = json!({ "allowed": !s.cfg.deny_all_access_reviews });
    if review.get("apiVersion").is_none() {
        review["apiVersion"] = json!("authorization.k8s.io/v1");
    }
    if review.get("kind").is_none() {
        review["kind"] = json!("SelfSubjectAccessReview");
    }
    (
        StatusCode::CREATED,
        [(header::CONTENT_TYPE, "application/json")],
        review.to_string(),
    )
        .into_response()
}
