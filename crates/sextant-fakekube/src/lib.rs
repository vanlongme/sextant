//! A fake Kubernetes API server for tests. It speaks just enough of the API
//! for a real `kube` client to connect, discover, list, watch and write.

pub mod discovery;
pub mod objects;

use std::collections::{BTreeMap, VecDeque};
use std::convert::Infallible;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::{Query, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use tokio::sync::broadcast;
use tokio::task::JoinHandle;

use objects::{
    default_resources, field_selector_matches, label_selector_matches, merge_patch, parse_path,
    Target,
};
pub use objects::{DenyRule, FakeResource};

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
    /// Matching requests get a real 403 and a not-allowed access review.
    pub deny: Vec<DenyRule>,
    /// Like `deny`, but only for requests without a namespace (cluster-wide).
    /// The rule's `namespace` is ignored.
    pub deny_cluster_wide: Vec<DenyRule>,
    /// SelfSubjectAccessReview answers 500.
    pub fail_access_reviews: bool,
}

/// A write the fake received, for tests that check what the client sent.
#[derive(Clone, Debug)]
pub struct WriteRequest {
    pub query: BTreeMap<String, String>,
    /// `Null` when the body is not JSON.
    pub body: Value,
}

#[derive(Clone)]
struct WatchEvent {
    rv: u64,
    plural: String,
    namespace: String,
    kind: &'static str,
    object: Value,
}

struct State_ {
    rv: u64,
    uid: u64,
    resources: BTreeMap<String, FakeResource>,
    /// plural -> (namespace, name) -> object. Cluster-scoped objects use "" as namespace.
    objects: BTreeMap<String, BTreeMap<(String, String), Value>>,
    history: Vec<WatchEvent>,
    counts: BTreeMap<String, usize>,
    watch_counts: BTreeMap<String, usize>,
    fail: BTreeMap<String, u16>,
    fail_discovery: Option<u16>,
    /// (namespace, name) of a pod -> scripted eviction failure and the answers left.
    eviction_failures: BTreeMap<(String, String), (u16, Option<usize>)>,
    /// Whether an accepted eviction leaves the pod in place.
    hold_evicted_pods: bool,
    /// (method, path) -> the writes received, oldest first.
    writes: BTreeMap<(String, String), Vec<WriteRequest>>,
}

struct Inner {
    cfg: FakeKubeConfig,
    state: Mutex<State_>,
    events: broadcast::Sender<WatchEvent>,
    /// `None` ends every watch, `Some(plural)` ends the watches of that plural.
    stop_watches: broadcast::Sender<Option<String>>,
    open_watches: AtomicUsize,
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, State_> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn emit(&self, st: &mut State_, kind: &'static str, plural: &str, ns: &str, object: Value) {
        let ev = WatchEvent {
            rv: st.rv,
            plural: plural.to_string(),
            namespace: ns.to_string(),
            kind,
            object,
        };
        st.history.push(ev.clone());
        // No receivers is fine.
        let _ = self.events.send(ev);
    }

    /// Stores `obj` (which must carry metadata.name) and emits ADDED or MODIFIED.
    /// Returns the stored object and whether it was created.
    fn commit(&self, st: &mut State_, res: &FakeResource, mut obj: Value) -> (Value, bool) {
        let name = obj
            .pointer("/metadata/name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let ns = if res.namespaced {
            obj.pointer("/metadata/namespace")
                .and_then(Value::as_str)
                .unwrap_or("default")
                .to_string()
        } else {
            String::new()
        };
        let key = (ns.clone(), name.clone());
        let existing = st
            .objects
            .get(&res.plural)
            .and_then(|m| m.get(&key))
            .cloned();
        st.rv += 1;
        let rv = st.rv;
        obj["apiVersion"] = json!(res.api_version());
        obj["kind"] = json!(res.kind);
        if !obj["metadata"].is_object() {
            obj["metadata"] = json!({});
        }
        if res.namespaced {
            obj["metadata"]["namespace"] = json!(ns);
        }
        let uid = existing
            .as_ref()
            .and_then(|e| e.pointer("/metadata/uid"))
            .or_else(|| obj.pointer("/metadata/uid"))
            .and_then(Value::as_str)
            .filter(|u| !u.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| {
                st.uid += 1;
                format!("00000000-0000-4000-8000-{:012x}", st.uid)
            });
        let created_at = existing
            .as_ref()
            .and_then(|e| e.pointer("/metadata/creationTimestamp"))
            .or_else(|| obj.pointer("/metadata/creationTimestamp"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| "2026-01-01T00:00:00Z".to_string());
        obj["metadata"]["uid"] = json!(uid);
        obj["metadata"]["creationTimestamp"] = json!(created_at);
        obj["metadata"]["resourceVersion"] = json!(rv.to_string());
        st.objects
            .entry(res.plural.clone())
            .or_default()
            .insert(key, obj.clone());
        let created = existing.is_none();
        self.emit(
            st,
            if created { "ADDED" } else { "MODIFIED" },
            &res.plural,
            &ns,
            obj.clone(),
        );
        (obj, created)
    }

    fn remove(&self, st: &mut State_, plural: &str, ns: &str, name: &str) -> Option<Value> {
        let mut obj = st
            .objects
            .get_mut(plural)?
            .remove(&(ns.to_string(), name.to_string()))?;
        st.rv += 1;
        obj["metadata"]["resourceVersion"] = json!(st.rv.to_string());
        self.emit(st, "DELETED", plural, ns, obj.clone());
        Some(obj)
    }

    fn denied(&self, verb: &str, plural: &str, ns: Option<&str>) -> bool {
        self.cfg.deny.iter().any(|d| d.matches(verb, plural, ns))
            || (ns.is_none()
                && self
                    .cfg
                    .deny_cluster_wide
                    .iter()
                    .any(|d| d.verb == verb && d.plural == plural))
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
        let (stop_watches, _) = broadcast::channel(16);
        let names: Vec<String> = if cfg.namespaces.is_empty() {
            vec!["default".into(), "kube-system".into()]
        } else {
            cfg.namespaces.clone()
        };
        let resources: BTreeMap<String, FakeResource> = default_resources()
            .into_iter()
            .map(|r| (r.plural.clone(), r))
            .collect();
        let inner = Arc::new(Inner {
            cfg,
            state: Mutex::new(State_ {
                rv: 100,
                uid: 0,
                resources,
                objects: BTreeMap::new(),
                history: Vec::new(),
                counts: BTreeMap::new(),
                watch_counts: BTreeMap::new(),
                fail: BTreeMap::new(),
                fail_discovery: None,
                eviction_failures: BTreeMap::new(),
                hold_evicted_pods: false,
                writes: BTreeMap::new(),
            }),
            events,
            stop_watches,
            open_watches: AtomicUsize::new(0),
        });
        let fake_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let addr = fake_listener.local_addr()?;
        let app = router(inner.clone());
        let task = tokio::spawn(async move {
            let _ = axum::serve(fake_listener, app).await;
        });
        let fake = FakeKube { inner, addr, task };
        for n in names {
            fake.upsert(
                "namespaces",
                json!({
                    "metadata": { "name": n },
                    "spec": {},
                    "status": { "phase": "Active" },
                }),
            );
        }
        Ok(fake)
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

    /// Advertises a resource in discovery from now on and serves it.
    pub fn serve_resource(&self, r: FakeResource) {
        self.inner.lock().resources.insert(r.plural.clone(), r);
    }

    /// Removes the resource from discovery and drops its objects. Requests get
    /// 404 and open watches of it end.
    pub fn remove_resource(&self, plural: &str) {
        {
            let mut st = self.inner.lock();
            st.resources.remove(plural);
            st.objects.remove(plural);
            st.history.retain(|e| e.plural != plural);
            st.fail.remove(plural);
        }
        let _ = self.inner.stop_watches.send(Some(plural.to_string()));
    }

    /// Creates or replaces an object: sets uid and resourceVersion and emits
    /// ADDED or MODIFIED. Panics when the plural is not served.
    pub fn upsert(&self, plural: &str, obj: Value) {
        let mut st = self.inner.lock();
        let Some(res) = st.resources.get(plural).cloned() else {
            panic!("upsert: resource {plural} is not served");
        };
        self.inner.commit(&mut st, &res, obj);
    }

    /// Deletes an object and emits DELETED. Unknown objects are ignored.
    pub fn delete(&self, plural: &str, namespace: Option<&str>, name: &str) {
        let mut st = self.inner.lock();
        self.inner
            .remove(&mut st, plural, namespace.unwrap_or(""), name);
    }

    /// Makes every watch and list of `plural` answer with this HTTP status
    /// until cleared with `None`.
    pub fn fail_watches_with(&self, plural: &str, http_status: Option<u16>) {
        let mut st = self.inner.lock();
        match http_status {
            Some(code) => st.fail.insert(plural.to_string(), code),
            None => st.fail.remove(plural),
        };
    }

    /// Makes the discovery documents (`/api`, `/apis` and each group version)
    /// answer with this HTTP status until cleared with `None`.
    pub fn fail_discovery_with(&self, http_status: Option<u16>) {
        self.inner.lock().fail_discovery = http_status;
    }

    /// Makes evicting the pod fail with `http_status`, `times` times or, for
    /// `None`, always.
    pub fn fail_evictions_with(
        &self,
        namespace: &str,
        name: &str,
        http_status: u16,
        times: Option<usize>,
    ) {
        self.inner.lock().eviction_failures.insert(
            (namespace.to_string(), name.to_string()),
            (http_status, times),
        );
    }

    /// With `true`, an accepted eviction answers 201 but leaves the pod in place.
    pub fn hold_evicted_pods(&self, hold: bool) {
        self.inner.lock().hold_evicted_pods = hold;
    }

    /// Adds a pod and emits a watch ADDED event.
    pub fn add_pod(&self, namespace: &str, name: &str) {
        self.upsert("pods", pod_json(namespace, name));
    }

    /// Removes a pod and emits a watch DELETED event.
    pub fn delete_pod(&self, namespace: &str, name: &str) {
        self.delete("pods", Some(namespace), name);
    }

    /// Closes open watch streams.
    pub fn drop_watches(&self) {
        let _ = self.inner.stop_watches.send(None);
    }

    /// Sends a 410 ERROR event on the open watches of `plural`, as a server does
    /// when their resourceVersion has expired. The stream stays open.
    pub fn expire_watches(&self, plural: &str) {
        let mut st = self.inner.lock();
        st.rv += 1;
        let ev = WatchEvent {
            rv: st.rv,
            plural: plural.to_string(),
            namespace: String::new(),
            kind: "ERROR",
            object: json!({
                "kind": "Status",
                "apiVersion": "v1",
                "metadata": {},
                "status": "Failure",
                "message": "too old resource version",
                "reason": "Expired",
                "code": 410,
            }),
        };
        // Not in the history: a watch that resumes must not see it again.
        let _ = self.inner.events.send(ev);
    }

    pub fn request_count(&self, path: &str) -> usize {
        self.inner.lock().counts.get(path).copied().unwrap_or(0)
    }

    /// How many watch requests reached `path`, without its lists.
    pub fn watch_request_count(&self, path: &str) -> usize {
        self.inner
            .lock()
            .watch_counts
            .get(path)
            .copied()
            .unwrap_or(0)
    }

    /// The writes that reached `path` with this method, oldest first.
    pub fn writes(&self, method: &str, path: &str) -> Vec<WriteRequest> {
        self.inner
            .lock()
            .writes
            .get(&(method.to_string(), path.to_string()))
            .cloned()
            .unwrap_or_default()
    }

    /// How many watch streams are open right now.
    pub fn open_watch_count(&self) -> usize {
        self.inner.open_watches.load(Ordering::SeqCst)
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

fn pod_json(namespace: &str, name: &str) -> Value {
    json!({
        "metadata": { "name": name, "namespace": namespace },
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

fn status_for_code(code: u16) -> Response {
    let reason = match code {
        400 => "BadRequest",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "NotFound",
        409 => "Conflict",
        410 => "Expired",
        429 => "TooManyRequests",
        500 => "InternalError",
        503 => "ServiceUnavailable",
        _ => "Failure",
    };
    status(
        code,
        reason,
        &format!("injected failure with status {code}"),
    )
}

fn not_found() -> Response {
    status(
        404,
        "NotFound",
        "the server could not find the requested resource",
    )
}

fn json_ok(v: Value) -> Response {
    ([(header::CONTENT_TYPE, "application/json")], v.to_string()).into_response()
}

fn json_code(code: StatusCode, v: Value) -> Response {
    (
        code,
        [(header::CONTENT_TYPE, "application/json")],
        v.to_string(),
    )
        .into_response()
}

fn router(inner: Shared) -> Router {
    Router::new()
        .route("/version", get(version))
        .route("/api", get(api))
        .route("/apis", get(apis))
        .route("/api/v1", get(group_version_doc))
        .route("/apis/{group}/{version}", get(group_version_doc))
        .route(
            "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews",
            post(access_review),
        )
        .fallback(generic)
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

fn served(s: &Shared) -> Vec<FakeResource> {
    s.lock().resources.values().cloned().collect()
}

fn discovery_failure(s: &Shared) -> Option<Response> {
    s.lock().fail_discovery.map(status_for_code)
}

async fn api(State(s): State<Shared>, headers: HeaderMap) -> Response {
    if let Some(failure) = discovery_failure(&s) {
        return failure;
    }
    if !s.cfg.no_aggregated_discovery && wants_aggregated(&headers) {
        aggregated(discovery::aggregated_core(&served(&s)))
    } else {
        json_ok(discovery::legacy_api_versions())
    }
}

async fn apis(State(s): State<Shared>, headers: HeaderMap) -> Response {
    if let Some(failure) = discovery_failure(&s) {
        return failure;
    }
    let rs = served(&s);
    if !s.cfg.no_aggregated_discovery && wants_aggregated(&headers) {
        aggregated(discovery::aggregated_apis(&rs))
    } else {
        json_ok(discovery::legacy_api_group_list(&rs))
    }
}

async fn group_version_doc(State(s): State<Shared>, uri: Uri) -> Response {
    if let Some(failure) = discovery_failure(&s) {
        return failure;
    }
    let segs: Vec<&str> = uri.path().trim_matches('/').split('/').collect();
    let (group, version) = match segs.as_slice() {
        ["api", v] => ("", *v),
        ["apis", g, v] => (*g, *v),
        _ => return not_found(),
    };
    match discovery::resource_list(&served(&s), group, version) {
        Some(doc) => json_ok(doc),
        None => not_found(),
    }
}

type Params = Query<BTreeMap<String, String>>;

fn forbidden(res: &FakeResource, verb: &str, ns: Option<&str>) -> Response {
    let scope = match ns {
        Some(n) => format!("in the namespace \"{n}\""),
        None => "at the cluster scope".to_string(),
    };
    status(
        403,
        "Forbidden",
        &format!(
            "{} is forbidden: User \"fake\" cannot {verb} resource \"{}\" in API group \"{}\" {scope}",
            res.plural, res.plural, res.group
        ),
    )
}

fn request_verb(method: &Method, has_name: bool, watch: bool) -> Option<&'static str> {
    Some(match (method.as_str(), has_name) {
        ("GET", false) if watch => "watch",
        ("GET", false) => "list",
        ("GET", true) => "get",
        ("POST", false) | ("POST", true) => "create",
        ("PUT", true) => "update",
        ("PATCH", true) => "patch",
        ("DELETE", true) => "delete",
        _ => return None,
    })
}

async fn generic(
    State(s): State<Shared>,
    method: Method,
    uri: Uri,
    Query(q): Params,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if method != Method::GET {
        let write = WriteRequest {
            query: q.clone(),
            body: serde_json::from_slice(&body).unwrap_or(Value::Null),
        };
        s.lock()
            .writes
            .entry((method.to_string(), uri.path().to_string()))
            .or_default()
            .push(write);
    }
    let Some(t) = parse_path(uri.path()) else {
        return not_found();
    };
    let res = s
        .lock()
        .resources
        .get(&t.plural)
        .filter(|r| r.group == t.group && r.version == t.version)
        .cloned();
    let Some(res) = res else {
        return not_found();
    };
    if (t.namespace.is_some() && !res.namespaced)
        || (t.name.is_some() && res.namespaced && t.namespace.is_none())
    {
        return not_found();
    }
    let watch = q.get("watch").is_some_and(|v| v == "true" || v == "1");
    let named_post = method == Method::POST && t.name.is_some() && t.subresource.is_none();
    let verb = if named_post {
        None
    } else {
        request_verb(&method, t.name.is_some(), watch)
    };
    let Some(verb) = verb else {
        return status(
            405,
            "MethodNotAllowed",
            "method not supported for this path",
        );
    };
    let ns = t.namespace.as_deref();
    let legacy_forbid = (res.plural == "namespaces"
        && t.name.is_none()
        && verb == "list"
        && s.cfg.forbid_namespace_list)
        || (res.plural == "pods"
            && ns.is_none()
            && t.name.is_none()
            && verb == "list"
            && s.cfg.forbid_cluster_wide_pods);
    let denied_plural = match &t.subresource {
        Some(sub) => format!("{}/{sub}", res.plural),
        None => res.plural.clone(),
    };
    if legacy_forbid || s.denied(verb, &denied_plural, ns) {
        return forbidden(&res, verb, ns);
    }
    if let Some(sub) = t.subresource.as_deref() {
        return subresource(&s, &res, &t, sub, &method, &headers, &body);
    }
    if t.name.is_none() && method == Method::GET {
        let failure = s.lock().fail.get(&res.plural).copied();
        if let Some(code) = failure {
            return status_for_code(code);
        }
    }
    match verb {
        "list" => list(&s, &res, &t, &q),
        "watch" => watch_response(s, &res, &t, uri.path(), &q),
        "get" => get_one(&s, &res, &t),
        "create" => create(&s, &res, &t, &body),
        "update" => update(&s, &res, &t, &body),
        "patch" => patch(&s, &res, &t, &headers, &body),
        _ => delete_one(&s, &res, &t),
    }
}

/// The subresources the fake knows: `scale` and `eviction`.
fn subresource(
    s: &Shared,
    res: &FakeResource,
    t: &Target,
    sub: &str,
    method: &Method,
    headers: &HeaderMap,
    body: &[u8],
) -> Response {
    let key = key_of(res, t);
    match (sub, method.as_str(), res.plural.as_str()) {
        ("scale", "PATCH", "deployments" | "statefulsets" | "replicasets") => {
            let is_merge = headers
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .is_some_and(|c| c.contains("merge-patch"));
            if !is_merge {
                return status(415, "UnsupportedMediaType", "unsupported patch type");
            }
            let doc = match parse_object(body) {
                Ok(v) => v,
                Err(r) => return *r,
            };
            let mut st = s.lock();
            let Some(mut current) = st
                .objects
                .get(&res.plural)
                .and_then(|m| m.get(&key))
                .cloned()
            else {
                return not_found_object(res, &key.1);
            };
            let replicas = doc
                .pointer("/spec/replicas")
                .cloned()
                .unwrap_or(Value::Null);
            if !current["spec"].is_object() {
                current["spec"] = json!({});
            }
            current["spec"]["replicas"] = replicas.clone();
            s.commit(&mut st, res, current);
            json_ok(json!({
                "kind": "Scale",
                "apiVersion": "autoscaling/v1",
                "metadata": { "name": key.1, "namespace": key.0 },
                "spec": { "replicas": replicas },
            }))
        }
        ("eviction", "POST", "pods") => {
            let mut st = s.lock();
            let failure = st
                .eviction_failures
                .get_mut(&key)
                .and_then(|(code, left)| match left {
                    Some(0) => None,
                    Some(n) => {
                        *n -= 1;
                        Some(*code)
                    }
                    None => Some(*code),
                });
            if let Some(code) = failure {
                return if code == 429 {
                    status(
                        429,
                        "TooManyRequests",
                        "Cannot evict pod as it would violate the pod's disruption budget.",
                    )
                } else {
                    status_for_code(code)
                };
            }
            let exists = st
                .objects
                .get(&res.plural)
                .is_some_and(|m| m.contains_key(&key));
            if !exists {
                return not_found_object(res, &key.1);
            }
            if !st.hold_evicted_pods {
                s.remove(&mut st, &res.plural, &key.0, &key.1);
            }
            json_code(
                StatusCode::CREATED,
                json!({ "kind": "Status", "apiVersion": "v1", "status": "Success", "metadata": {} }),
            )
        }
        _ => not_found(),
    }
}

fn not_found_object(res: &FakeResource, name: &str) -> Response {
    status(
        404,
        "NotFound",
        &format!("{} \"{name}\" not found", res.plural),
    )
}

fn key_of(res: &FakeResource, t: &Target) -> (String, String) {
    (
        if res.namespaced {
            t.namespace.clone().unwrap_or_default()
        } else {
            String::new()
        },
        t.name.clone().unwrap_or_default(),
    )
}

fn selected(obj: &Value, q: &BTreeMap<String, String>) -> bool {
    q.get("labelSelector")
        .is_none_or(|sel| label_selector_matches(sel, obj))
        && q.get("fieldSelector")
            .is_none_or(|sel| field_selector_matches(sel, obj))
}

/// A real API server leaves `kind` and `apiVersion` out of list items.
fn list_item(obj: &Value) -> Value {
    let mut item = obj.clone();
    if let Some(fields) = item.as_object_mut() {
        fields.remove("kind");
        fields.remove("apiVersion");
    }
    item
}

fn list(s: &Shared, res: &FakeResource, t: &Target, q: &BTreeMap<String, String>) -> Response {
    let st = s.lock();
    let items: Vec<Value> = st
        .objects
        .get(&res.plural)
        .map(|m| {
            m.iter()
                .filter(|((ns, _), _)| t.namespace.as_deref().is_none_or(|n| n == ns))
                .map(|(_, o)| o)
                .filter(|o| selected(o, q))
                .map(list_item)
                .collect()
        })
        .unwrap_or_default();
    json_ok(json!({
        "apiVersion": res.api_version(),
        "kind": format!("{}List", res.kind),
        "metadata": { "resourceVersion": st.rv.to_string() },
        "items": items,
    }))
}

fn get_one(s: &Shared, res: &FakeResource, t: &Target) -> Response {
    let key = key_of(res, t);
    let st = s.lock();
    match st.objects.get(&res.plural).and_then(|m| m.get(&key)) {
        Some(o) => json_ok(o.clone()),
        None => not_found_object(res, &key.1),
    }
}

fn parse_object(body: &[u8]) -> Result<Value, Box<Response>> {
    match serde_json::from_slice::<Value>(body) {
        Ok(v) if v.is_object() => Ok(v),
        _ => Err(Box::new(status(
            400,
            "BadRequest",
            "the request body is not a JSON object",
        ))),
    }
}

fn check_namespace(obj: &Value, t: &Target) -> Result<(), Box<Response>> {
    let body_ns = obj.pointer("/metadata/namespace").and_then(Value::as_str);
    match (body_ns, t.namespace.as_deref()) {
        (Some(b), Some(p)) if !b.is_empty() && b != p => Err(Box::new(status(
            400,
            "BadRequest",
            "the namespace of the provided object does not match the namespace sent on the request",
        ))),
        _ => Ok(()),
    }
}

fn set_identity(obj: &mut Value, res: &FakeResource, t: &Target, name: &str) {
    if !obj["metadata"].is_object() {
        obj["metadata"] = json!({});
    }
    obj["metadata"]["name"] = json!(name);
    if res.namespaced {
        obj["metadata"]["namespace"] = json!(t.namespace.clone().unwrap_or_default());
    }
}

fn conflict(res: &FakeResource, name: &str) -> Response {
    status(
        409,
        "Conflict",
        &format!(
            "Operation cannot be fulfilled on {} \"{name}\": the object has been modified; please apply your changes to the latest version and try again",
            res.plural
        ),
    )
}

fn create(s: &Shared, res: &FakeResource, t: &Target, body: &[u8]) -> Response {
    let mut obj = match parse_object(body) {
        Ok(o) => o,
        Err(r) => return *r,
    };
    if let Err(r) = check_namespace(&obj, t) {
        return *r;
    }
    let mut st = s.lock();
    let name = match obj.pointer("/metadata/name").and_then(Value::as_str) {
        Some(n) if !n.is_empty() => n.to_string(),
        _ => match obj
            .pointer("/metadata/generateName")
            .and_then(Value::as_str)
        {
            Some(prefix) => {
                st.uid += 1;
                format!("{prefix}{:05x}", st.uid)
            }
            None => {
                return status(
                    422,
                    "Invalid",
                    "metadata.name or metadata.generateName is required",
                )
            }
        },
    };
    set_identity(&mut obj, res, t, &name);
    let key = (key_of(res, t).0, name.clone());
    if st
        .objects
        .get(&res.plural)
        .is_some_and(|m| m.contains_key(&key))
    {
        return status(
            409,
            "AlreadyExists",
            &format!("{} \"{name}\" already exists", res.plural),
        );
    }
    let (stored, _) = s.commit(&mut st, res, obj);
    json_code(StatusCode::CREATED, stored)
}

fn update(s: &Shared, res: &FakeResource, t: &Target, body: &[u8]) -> Response {
    let mut obj = match parse_object(body) {
        Ok(o) => o,
        Err(r) => return *r,
    };
    if let Err(r) = check_namespace(&obj, t) {
        return *r;
    }
    let key = key_of(res, t);
    let mut st = s.lock();
    let Some(current) = st
        .objects
        .get(&res.plural)
        .and_then(|m| m.get(&key))
        .cloned()
    else {
        return not_found_object(res, &key.1);
    };
    if let Some(name) = obj.pointer("/metadata/name").and_then(Value::as_str) {
        if name != key.1 {
            return status(
                400,
                "BadRequest",
                "the name of the object does not match the name on the URL",
            );
        }
    }
    let sent = obj
        .pointer("/metadata/resourceVersion")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty());
    if sent.is_some_and(|v| {
        Some(v)
            != current
                .pointer("/metadata/resourceVersion")
                .and_then(Value::as_str)
    }) {
        return conflict(res, &key.1);
    }
    set_identity(&mut obj, res, t, &key.1);
    obj["metadata"]["uid"] = current["metadata"]["uid"].clone();
    let (stored, _) = s.commit(&mut st, res, obj);
    json_ok(stored)
}

fn patch(s: &Shared, res: &FakeResource, t: &Target, headers: &HeaderMap, body: &[u8]) -> Response {
    let ctype = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let apply = ctype.contains("apply-patch");
    let patch_doc: Value = if apply {
        match serde_yaml_ng::from_slice::<Value>(body) {
            Ok(v) if v.is_object() => v,
            _ => return status(400, "BadRequest", "the apply patch is not a YAML mapping"),
        }
    } else if ctype.contains("merge-patch") {
        match parse_object(body) {
            Ok(v) => v,
            Err(r) => return *r,
        }
    } else {
        return status(
            415,
            "UnsupportedMediaType",
            "unsupported patch type; use apply-patch+yaml or merge-patch+json",
        );
    };
    if let Err(r) = check_namespace(&patch_doc, t) {
        return *r;
    }
    let key = key_of(res, t);
    let mut st = s.lock();
    let current = st
        .objects
        .get(&res.plural)
        .and_then(|m| m.get(&key))
        .cloned();
    let sent_rv = patch_doc
        .pointer("/metadata/resourceVersion")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .map(str::to_string);
    let mut patch_doc = patch_doc;
    if let Some(m) = patch_doc.get_mut("metadata").and_then(Value::as_object_mut) {
        m.remove("resourceVersion");
        m.remove("managedFields");
    }
    let Some(current) = current else {
        if !apply {
            return not_found_object(res, &key.1);
        }
        // A server-side apply that would create the object also needs `create`.
        if s.denied("create", &res.plural, t.namespace.as_deref()) {
            return forbidden(res, "create", t.namespace.as_deref());
        }
        let mut obj = patch_doc;
        set_identity(&mut obj, res, t, &key.1);
        let (stored, _) = s.commit(&mut st, res, obj);
        return json_code(StatusCode::CREATED, stored);
    };
    let current_rv = current
        .pointer("/metadata/resourceVersion")
        .and_then(Value::as_str)
        .map(str::to_string);
    if sent_rv.is_some() && sent_rv != current_rv {
        return conflict(res, &key.1);
    }
    let mut merged = current.clone();
    merge_patch(&mut merged, &patch_doc);
    set_identity(&mut merged, res, t, &key.1);
    merged["metadata"]["uid"] = current["metadata"]["uid"].clone();
    merged["metadata"]["resourceVersion"] = current["metadata"]["resourceVersion"].clone();
    if merged == current {
        return json_ok(current);
    }
    let (stored, _) = s.commit(&mut st, res, merged);
    json_ok(stored)
}

fn delete_one(s: &Shared, res: &FakeResource, t: &Target) -> Response {
    let key = key_of(res, t);
    let mut st = s.lock();
    match s.remove(&mut st, &res.plural, &key.0, &key.1) {
        Some(o) => json_ok(o),
        None => not_found_object(res, &key.1),
    }
}

/// Counts a watch stream as open for as long as its response body lives.
struct OpenWatch(Shared);

impl OpenWatch {
    fn new(s: Shared) -> Self {
        s.open_watches.fetch_add(1, Ordering::SeqCst);
        OpenWatch(s)
    }
}

impl Drop for OpenWatch {
    fn drop(&mut self) {
        self.0.open_watches.fetch_sub(1, Ordering::SeqCst);
    }
}

struct WatchState {
    _open: OpenWatch,
    backlog: VecDeque<WatchEvent>,
    rx: broadcast::Receiver<WatchEvent>,
    stop: broadcast::Receiver<Option<String>>,
    plural: String,
    ns: Option<String>,
    query: BTreeMap<String, String>,
    last_rv: u64,
}

fn watch_response(
    s: Shared,
    res: &FakeResource,
    t: &Target,
    path: &str,
    q: &BTreeMap<String, String>,
) -> Response {
    let since: Option<u64> = q.get("resourceVersion").and_then(|v| v.parse().ok());
    // Subscribe and snapshot history under one lock so no event is missed or duplicated.
    let (backlog, rx, stop, since) = {
        let mut st = s.lock();
        *st.watch_counts.entry(path.to_string()).or_insert(0) += 1;
        let since = since.unwrap_or(st.rv);
        let backlog: VecDeque<WatchEvent> = st
            .history
            .iter()
            .filter(|e| e.rv > since && e.plural == res.plural)
            .cloned()
            .collect();
        (
            backlog,
            s.events.subscribe(),
            s.stop_watches.subscribe(),
            since,
        )
    };
    let state = WatchState {
        _open: OpenWatch::new(s),
        backlog,
        rx,
        stop,
        plural: res.plural.clone(),
        ns: t.namespace.clone(),
        query: q.clone(),
        last_rv: since,
    };
    let stream = futures::stream::unfold(state, |mut w| async move {
        loop {
            let ev = if let Some(ev) = w.backlog.pop_front() {
                ev
            } else {
                tokio::select! {
                    stop = w.stop.recv() => match stop {
                        Ok(Some(p)) if p != w.plural => continue,
                        _ => return None,
                    },
                    r = w.rx.recv() => match r {
                        Ok(ev) => ev,
                        Err(_) => return None,
                    },
                }
            };
            if ev.rv <= w.last_rv
                || ev.plural != w.plural
                || w.ns.as_deref().is_some_and(|n| n != ev.namespace)
                || !selected(&ev.object, &w.query)
            {
                continue;
            }
            w.last_rv = ev.rv;
            let mut line = json!({ "type": ev.kind, "object": ev.object }).to_string();
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
    if s.cfg.fail_access_reviews {
        return status(500, "InternalError", "access reviews are failing");
    }
    let attrs = review.pointer("/spec/resourceAttributes");
    let text = |k: &str| {
        attrs
            .and_then(|a| a.get(k))
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
    };
    let denied = match (text("verb"), text("resource")) {
        (Some(verb), Some(resource)) => s.denied(verb, resource, text("namespace")),
        _ => false,
    };
    review["status"] = json!({ "allowed": !(s.cfg.deny_all_access_reviews || denied) });
    if review.get("apiVersion").is_none() {
        review["apiVersion"] = json!("authorization.k8s.io/v1");
    }
    if review.get("kind").is_none() {
        review["kind"] = json!("SelfSubjectAccessReview");
    }
    json_code(StatusCode::CREATED, review)
}
