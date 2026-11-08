//! The Argo CD actions against the fake API server: what each one reads and writes, and what
//! it refuses before writing. Every kubeconfig lives in a temp `<home>/.kube`.

mod support;

use serde_json::{json, Value};
use skopos_core::app_core::AppCore;
use skopos_core::error::ErrorCode;
use skopos_core::kubeconfig::ClusterId;
use skopos_core::resources::{
    ArgoRollbackOptions, ArgoSyncOptions, ArgoSyncResource, ArgoSyncStrategy,
    SYNC_WINDOWS_UNVERIFIED,
};
use skopos_fakekube::{DenyRule, FakeKube, FakeKubeConfig, FakeResource};
use support::connected_fake;
use tempfile::TempDir;

const NAMESPACE: &str = "argocd";
const APP: &str = "/apis/argoproj.io/v1alpha1/namespaces/argocd/applications/guestbook";

/// A fake that serves the two Argo CD kinds the actions touch.
async fn argocd(cfg: FakeKubeConfig) -> (AppCore, FakeKube, ClusterId, TempDir) {
    let cfg = FakeKubeConfig {
        namespaces: vec!["default".into(), NAMESPACE.into(), "argocd-system".into()],
        ..cfg
    };
    let (core, fake, id, root) = connected_fake(cfg).await;
    fake.serve_resource(FakeResource::new(
        "argoproj.io",
        "v1alpha1",
        "Application",
        "applications",
        true,
    ));
    fake.serve_resource(FakeResource::new(
        "argoproj.io",
        "v1alpha1",
        "AppProject",
        "appprojects",
        true,
    ));
    (core, fake, id, root)
}

fn application() -> Value {
    json!({
        "apiVersion": "argoproj.io/v1alpha1",
        "kind": "Application",
        "metadata": { "name": "guestbook", "namespace": NAMESPACE },
        "spec": {
            "project": "default",
            "source": {
                "repoURL": "https://git.example.com/apps.git",
                "path": "guestbook",
                "targetRevision": "main",
            },
            "destination": { "server": "https://kubernetes.default.svc", "namespace": "guestbook" },
        },
        "status": { "sync": { "status": "OutOfSync" } },
    })
}

fn project(namespace: &str, windows: Value) -> Value {
    json!({
        "apiVersion": "argoproj.io/v1alpha1",
        "kind": "AppProject",
        "metadata": { "name": "default", "namespace": namespace },
        "spec": { "syncWindows": windows },
    })
}

fn plain_sync() -> ArgoSyncOptions {
    ArgoSyncOptions {
        revision: None,
        prune: false,
        dry_run: false,
        force: false,
        strategy: ArgoSyncStrategy::Hook,
        sync_options: Vec::new(),
        resources: None,
        acknowledge_sync_windows: false,
    }
}

fn puts(fake: &FakeKube) -> Vec<Value> {
    fake.writes("PUT", APP)
        .into_iter()
        .map(|write| write.body)
        .collect()
}

/// The fixture most tests start from: the Application, and a project without windows.
async fn ready() -> (AppCore, FakeKube, ClusterId, TempDir) {
    let (core, fake, id, root) = argocd(FakeKubeConfig::default()).await;
    fake.upsert("applications", application());
    fake.upsert("appprojects", project(NAMESPACE, json!([])));
    (core, fake, id, root)
}

#[tokio::test]
async fn a_sync_puts_the_operation_and_clears_the_old_state() {
    let (core, fake, id, _root) = argocd(FakeKubeConfig::default()).await;
    let mut app = application();
    // Left by an earlier operation. Still marked running, it would be resumed instead.
    app["status"]["operationState"] = json!({
        "phase": "Running",
        "operation": { "sync": { "revision": "old" } },
    });
    fake.upsert("applications", app);
    fake.upsert("appprojects", project(NAMESPACE, json!([])));

    core.argocd_sync(&id, NAMESPACE, "guestbook", &plain_sync())
        .await
        .unwrap();

    let puts = puts(&fake);
    assert_eq!(puts.len(), 1);
    let body = &puts[0];
    let source = application()["spec"]["source"].clone();
    assert_eq!(
        body["operation"],
        json!({
            "sync": {
                "source": source,
                "prune": false,
                "dryRun": false,
                "syncStrategy": { "hook": { "force": false } },
            },
            "initiatedBy": { "username": "skopos" },
        })
    );
    assert!(body.pointer("/status/operationState").is_none(), "{body}");
    assert_eq!(body["status"]["sync"]["status"], "OutOfSync");
    assert!(body
        .pointer("/metadata/resourceVersion")
        .and_then(Value::as_str)
        .is_some_and(|version| !version.is_empty()));
}

#[tokio::test]
async fn an_operation_in_progress_is_refused_without_a_write() {
    let (core, fake, id, _root) = argocd(FakeKubeConfig::default()).await;
    let mut app = application();
    app["operation"] = json!({ "sync": {} });
    fake.upsert("applications", app);
    fake.upsert("appprojects", project(NAMESPACE, json!([])));

    let error = core
        .argocd_sync(&id, NAMESPACE, "guestbook", &plain_sync())
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict);
    assert_eq!(error.details, None);
    assert!(puts(&fake).is_empty());
}

#[tokio::test]
async fn a_deleting_application_is_refused_without_a_write() {
    let (core, fake, id, _root) = argocd(FakeKubeConfig::default()).await;
    let mut app = application();
    app["metadata"]["deletionTimestamp"] = json!("2026-11-08T08:00:00Z");
    fake.upsert("applications", app);
    fake.upsert("appprojects", project(NAMESPACE, json!([])));

    let error = core
        .argocd_sync(&id, NAMESPACE, "guestbook", &plain_sync())
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
    assert!(puts(&fake).is_empty());
}

#[tokio::test]
async fn a_project_with_sync_windows_asks_first() {
    let (core, fake, id, _root) = argocd(FakeKubeConfig::default()).await;
    fake.upsert("applications", application());
    let window = json!([{ "kind": "deny", "schedule": "* * * * *", "duration": "1h", "applications": ["*"] }]);
    fake.upsert("appprojects", project(NAMESPACE, window));

    let error = core
        .argocd_sync(&id, NAMESPACE, "guestbook", &plain_sync())
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict);
    assert_eq!(error.details.as_deref(), Some(SYNC_WINDOWS_UNVERIFIED));
    assert!(puts(&fake).is_empty());

    let acknowledged = ArgoSyncOptions {
        acknowledge_sync_windows: true,
        ..plain_sync()
    };
    core.argocd_sync(&id, NAMESPACE, "guestbook", &acknowledged)
        .await
        .unwrap();
    assert_eq!(puts(&fake).len(), 1);
}

#[tokio::test]
async fn a_project_that_cannot_be_read_asks_first() {
    // The project is missing.
    let (core, fake, id, _root) = argocd(FakeKubeConfig::default()).await;
    fake.upsert("applications", application());
    let error = core
        .argocd_sync(&id, NAMESPACE, "guestbook", &plain_sync())
        .await
        .unwrap_err();
    assert_eq!(error.details.as_deref(), Some(SYNC_WINDOWS_UNVERIFIED));
    assert!(puts(&fake).is_empty());

    // The user may not read it.
    let deny = DenyRule {
        verb: "get".into(),
        plural: "appprojects".into(),
        namespace: None,
    };
    let cfg = FakeKubeConfig {
        deny: vec![deny],
        ..FakeKubeConfig::default()
    };
    let (core, fake, id, _root) = argocd(cfg).await;
    fake.upsert("applications", application());
    fake.upsert("appprojects", project(NAMESPACE, json!([])));
    let error = core
        .argocd_sync(&id, NAMESPACE, "guestbook", &plain_sync())
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict);
    assert_eq!(error.details.as_deref(), Some(SYNC_WINDOWS_UNVERIFIED));
    assert!(puts(&fake).is_empty());
}

#[tokio::test]
async fn the_project_is_read_where_the_controller_runs() {
    let (core, fake, id, _root) = argocd(FakeKubeConfig::default()).await;
    let mut app = application();
    app["status"]["controllerNamespace"] = json!("argocd-system");
    fake.upsert("applications", app);
    // Only there: a project read beside the Application would be missing.
    fake.upsert("appprojects", project("argocd-system", json!([])));

    core.argocd_sync(&id, NAMESPACE, "guestbook", &plain_sync())
        .await
        .unwrap();
    assert_eq!(puts(&fake).len(), 1);
}

#[tokio::test]
async fn a_conflict_reads_again_and_retries() {
    let (core, fake, id, _root) = ready().await;
    fake.fail_next_writes_to("applications", "guestbook", 409, 2);

    core.argocd_sync(&id, NAMESPACE, "guestbook", &plain_sync())
        .await
        .unwrap();
    assert_eq!(puts(&fake).len(), 3);
}

#[tokio::test]
async fn a_conflict_that_lasts_gives_up_after_five_attempts() {
    let (core, fake, id, _root) = ready().await;
    fake.fail_next_writes_to("applications", "guestbook", 409, 10);

    let error = core
        .argocd_sync(&id, NAMESPACE, "guestbook", &plain_sync())
        .await
        .unwrap_err();
    // The API server's own error, not the refusal about sync windows.
    assert_eq!(error.code, ErrorCode::Conflict);
    assert_eq!(error.details.as_deref(), Some("HTTP 409"));
    assert_eq!(puts(&fake).len(), 5);
}

#[tokio::test]
async fn another_refused_write_is_not_retried() {
    let (core, fake, id, _root) = ready().await;
    fake.fail_writes_to("applications", "guestbook", Some(403));

    let error = core
        .argocd_sync(&id, NAMESPACE, "guestbook", &plain_sync())
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Forbidden);
    assert_eq!(puts(&fake).len(), 1);
}

#[tokio::test]
async fn bad_arguments_are_refused_before_any_request() {
    let (core, fake, id, _root) = ready().await;
    let error = core
        .argocd_sync(&id, NAMESPACE, "../guestbook", &plain_sync())
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);

    let nameless = ArgoSyncOptions {
        resources: Some(vec![ArgoSyncResource {
            group: "apps".into(),
            kind: "Deployment".into(),
            namespace: None,
            name: " ".into(),
        }]),
        ..plain_sync()
    };
    let error = core
        .argocd_sync(&id, NAMESPACE, "guestbook", &nameless)
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
    assert_eq!(fake.request_count(APP), 0);
}

fn rollback(history_id: i64) -> ArgoRollbackOptions {
    ArgoRollbackOptions {
        history_id,
        prune: false,
        dry_run: false,
        acknowledge_sync_windows: false,
    }
}

fn with_history() -> Value {
    let mut app = application();
    app["status"]["history"] = json!([{
        "id": 1,
        "revision": "aaa",
        "source": application()["spec"]["source"],
        "deployedAt": "2026-11-01T08:00:00Z",
    }]);
    app
}

#[tokio::test]
async fn a_rollback_puts_a_sync_of_the_history_entry() {
    let (core, fake, id, _root) = argocd(FakeKubeConfig::default()).await;
    fake.upsert("applications", with_history());
    fake.upsert("appprojects", project(NAMESPACE, json!([])));

    core.argocd_rollback(&id, NAMESPACE, "guestbook", &rollback(1))
        .await
        .unwrap();

    let puts = puts(&fake);
    assert_eq!(puts.len(), 1);
    let sync = &puts[0]["operation"]["sync"];
    assert_eq!(sync["revision"], "aaa");
    assert_eq!(sync["syncStrategy"], json!({ "apply": {} }));
    assert_eq!(puts[0]["operation"]["initiatedBy"]["username"], "skopos");
}

#[tokio::test]
async fn a_rollback_asks_about_windows_and_refuses_a_running_operation() {
    let (core, fake, id, _root) = argocd(FakeKubeConfig::default()).await;
    fake.upsert("applications", with_history());
    let window = json!([{ "kind": "allow", "schedule": "0 22 * * *", "duration": "1h", "applications": ["*"] }]);
    fake.upsert("appprojects", project(NAMESPACE, window));
    let error = core
        .argocd_rollback(&id, NAMESPACE, "guestbook", &rollback(1))
        .await
        .unwrap_err();
    assert_eq!(error.details.as_deref(), Some(SYNC_WINDOWS_UNVERIFIED));

    let mut running = with_history();
    running["operation"] = json!({ "sync": {} });
    fake.upsert("applications", running);
    let acknowledged = ArgoRollbackOptions {
        acknowledge_sync_windows: true,
        ..rollback(1)
    };
    let error = core
        .argocd_rollback(&id, NAMESPACE, "guestbook", &acknowledged)
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict);
    assert_eq!(error.details, None);
    assert!(puts(&fake).is_empty());
}

#[tokio::test]
async fn terminate_puts_the_terminating_phase_and_retries_a_conflict() {
    let (core, fake, id, _root) = argocd(FakeKubeConfig::default()).await;
    let mut app = application();
    app["operation"] = json!({ "sync": {}, "initiatedBy": { "username": "someone" } });
    app["status"]["operationState"] = json!({ "phase": "Running", "operation": { "sync": {} } });
    fake.upsert("applications", app);
    fake.fail_next_writes_to("applications", "guestbook", 409, 1);

    core.argocd_terminate(&id, NAMESPACE, "guestbook")
        .await
        .unwrap();

    let puts = puts(&fake);
    assert_eq!(puts.len(), 2);
    assert_eq!(puts[1]["status"]["operationState"]["phase"], "Terminating");
    assert_eq!(puts[1]["operation"]["initiatedBy"]["username"], "someone");
}

#[tokio::test]
async fn terminate_with_nothing_in_progress_is_refused_without_a_write() {
    let (core, fake, id, _root) = ready().await;
    let error = core
        .argocd_terminate(&id, NAMESPACE, "guestbook")
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
    assert!(puts(&fake).is_empty());
}
