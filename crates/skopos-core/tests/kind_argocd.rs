//! The Argo CD actions against the real Application and AppProject CRDs of v3.6.1, which
//! `scripts/kind-up.sh` installs. No controller runs here, so these tests show what the API
//! server keeps of each write: it prunes a field the CRD does not know, without an error.
//! Needs `make test-kind`. Only `e2e/.tmp/kubeconfig` is read, never a default one.

mod support;

use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::time::{Duration, Instant};

use futures::FutureExt;
use kube::api::{
    ApiResource, DeleteParams, DynamicObject, ListParams, Patch, PatchParams, PostParams,
};
use kube::{Api, Client};
use serde_json::{json, Value};
use skopos_core::error::ErrorCode;
use skopos_core::resources::{
    ArgoRollbackOptions, ArgoSyncOptions, ArgoSyncResource, ArgoSyncStrategy,
    SYNC_WINDOWS_UNVERIFIED,
};
use support::{connected_kind, in_namespace};

const RESOURCES_FINALIZER: &str = "resources-finalizer.argocd.argoproj.io";
const WAIT: Duration = Duration::from_secs(30);

fn argo_api(client: &Client, namespace: &str, kind: &str, plural: &str) -> Api<DynamicObject> {
    let resource = ApiResource {
        group: "argoproj.io".into(),
        version: "v1alpha1".into(),
        api_version: "argoproj.io/v1alpha1".into(),
        kind: kind.into(),
        plural: plural.into(),
    };
    Api::namespaced_with(client.clone(), namespace, &resource)
}

fn applications(client: &Client, namespace: &str) -> Api<DynamicObject> {
    argo_api(client, namespace, "Application", "applications")
}

fn projects(client: &Client, namespace: &str) -> Api<DynamicObject> {
    argo_api(client, namespace, "AppProject", "appprojects")
}

async fn create(api: &Api<DynamicObject>, object: Value) {
    let object: DynamicObject = serde_json::from_value(object).unwrap();
    api.create(&PostParams::default(), &object).await.unwrap();
}

async fn read(api: &Api<DynamicObject>, name: &str) -> Value {
    serde_json::to_value(api.get(name).await.unwrap()).unwrap()
}

fn application(name: &str, namespace: &str) -> Value {
    json!({
        "apiVersion": "argoproj.io/v1alpha1",
        "kind": "Application",
        "metadata": { "name": name, "namespace": namespace },
        "spec": {
            "project": "default",
            "source": {
                "repoURL": "https://git.example.com/apps.git",
                "path": "guestbook",
                "targetRevision": "main",
            },
            "destination": { "server": "https://kubernetes.default.svc", "namespace": "guestbook" },
        },
    })
}

/// The project the window rule reads: no `status.controllerNamespace` is set without a
/// controller, so it is read beside the Application.
fn project(namespace: &str, windows: Value) -> Value {
    json!({
        "apiVersion": "argoproj.io/v1alpha1",
        "kind": "AppProject",
        "metadata": { "name": "default", "namespace": namespace },
        "spec": {
            "sourceRepos": ["*"],
            "destinations": [{ "server": "*", "namespace": "*" }],
            "syncWindows": windows,
        },
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

/// Strips the finalizers of every Application in the namespace. No controller runs here to
/// remove them, and deleting the namespace would never finish otherwise.
async fn release_applications(client: &Client, namespace: &str) {
    let apps = applications(client, namespace);
    let Ok(list) = apps.list(&ListParams::default()).await else {
        return;
    };
    let release = Patch::Merge(json!({ "metadata": { "finalizers": null } }));
    for app in list {
        if let Some(name) = app.metadata.name {
            let _ = apps.patch(&name, &PatchParams::default(), &release).await;
        }
    }
}

/// Runs a test in a new namespace, releasing the Applications before the namespace goes,
/// including those left by an earlier failed run.
async fn with_applications<Fut: Future<Output = ()>>(client: &Client, namespace: &str, test: Fut) {
    release_applications(client, namespace).await;
    in_namespace(client, namespace, async {
        let result = AssertUnwindSafe(test).catch_unwind().await;
        release_applications(client, namespace).await;
        if let Err(panic) = result {
            std::panic::resume_unwind(panic);
        }
    })
    .await;
}

#[tokio::test]
#[ignore = "needs the skopos-e2e kind cluster"]
async fn a_sync_operation_keeps_every_field_through_the_crd_schema() {
    const NAMESPACE: &str = "skopos-test-argocd-sync";
    let (core, id, _root) = connected_kind().await;
    let client = core.cluster_client(&id).unwrap();
    with_applications(&client, NAMESPACE, async {
        create(&projects(&client, NAMESPACE), project(NAMESPACE, json!([]))).await;
        let mut app = application("guestbook", NAMESPACE);
        let retry = json!({ "limit": 2, "backoff": { "duration": "5s", "factor": 2, "maxDuration": "1m" } });
        app["spec"]["syncPolicy"] = json!({ "syncOptions": ["CreateNamespace=true"], "retry": retry });
        app["status"] = json!({ "operationState": {
            "operation": { "sync": { "revision": "old" } },
            "phase": "Running",
            "startedAt": "2026-11-01T08:00:00Z",
        } });
        let source = app["spec"]["source"].clone();
        create(&applications(&client, NAMESPACE), app).await;

        let options = ArgoSyncOptions {
            revision: Some("v2".into()),
            prune: true,
            force: true,
            strategy: ArgoSyncStrategy::Apply,
            resources: Some(vec![ArgoSyncResource {
                group: "apps".into(),
                kind: "Deployment".into(),
                namespace: Some("guestbook".into()),
                name: "guestbook-ui".into(),
            }]),
            ..plain_sync()
        };
        core.argocd_sync(&id, NAMESPACE, "guestbook", &options)
            .await
            .unwrap();

        let stored = read(&applications(&client, NAMESPACE), "guestbook").await;
        assert_eq!(
            stored["operation"],
            json!({
                "sync": {
                    "source": source,
                    "revision": "v2",
                    "prune": true,
                    "dryRun": false,
                    "syncStrategy": { "apply": { "force": true } },
                    "syncOptions": ["CreateNamespace=true"],
                    "resources": [{
                        "group": "apps",
                        "kind": "Deployment",
                        "namespace": "guestbook",
                        "name": "guestbook-ui",
                    }],
                },
                "initiatedBy": { "username": "skopos" },
                "retry": retry,
            })
        );
        assert!(stored.pointer("/status/operationState").is_none(), "{stored}");

        // The operation now set blocks another.
        let error = core
            .argocd_sync(&id, NAMESPACE, "guestbook", &plain_sync())
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::Conflict);
    })
    .await;
}

#[tokio::test]
#[ignore = "needs the skopos-e2e kind cluster"]
async fn a_project_with_sync_windows_in_the_crd_asks_first() {
    const NAMESPACE: &str = "skopos-test-argocd-windows";
    let (core, id, _root) = connected_kind().await;
    let client = core.cluster_client(&id).unwrap();
    with_applications(&client, NAMESPACE, async {
        let window = json!([{ "kind": "allow", "schedule": "0 22 * * *", "duration": "1h", "applications": ["*"] }]);
        create(&projects(&client, NAMESPACE), project(NAMESPACE, window)).await;
        create(
            &applications(&client, NAMESPACE),
            application("guestbook", NAMESPACE),
        )
        .await;

        let error = core
            .argocd_sync(&id, NAMESPACE, "guestbook", &plain_sync())
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::Conflict);
        assert_eq!(error.details.as_deref(), Some(SYNC_WINDOWS_UNVERIFIED));
        let stored = read(&applications(&client, NAMESPACE), "guestbook").await;
        assert!(stored.get("operation").is_none(), "{stored}");
    })
    .await;
}

#[tokio::test]
#[ignore = "needs the skopos-e2e kind cluster"]
async fn rollback_and_terminate_keep_their_fields_through_the_crd_schema() {
    const NAMESPACE: &str = "skopos-test-argocd-rollback";
    let (core, id, _root) = connected_kind().await;
    let client = core.cluster_client(&id).unwrap();
    with_applications(&client, NAMESPACE, async {
        create(&projects(&client, NAMESPACE), project(NAMESPACE, json!([]))).await;
        let mut app = application("guestbook", NAMESPACE);
        let old_source = json!({
            "repoURL": "https://git.example.com/apps.git",
            "path": "guestbook",
            "targetRevision": "v1",
        });
        app["status"] = json!({ "history": [{
            "id": 3,
            "revision": "abc123",
            "source": old_source,
            "deployedAt": "2026-11-01T08:00:00Z",
        }] });
        create(&applications(&client, NAMESPACE), app).await;

        let rollback = ArgoRollbackOptions {
            history_id: 3,
            prune: true,
            dry_run: false,
            acknowledge_sync_windows: false,
        };
        core.argocd_rollback(&id, NAMESPACE, "guestbook", &rollback)
            .await
            .unwrap();
        let stored = read(&applications(&client, NAMESPACE), "guestbook").await;
        assert_eq!(
            stored["operation"],
            json!({
                "sync": {
                    "revision": "abc123",
                    "source": old_source,
                    "prune": true,
                    "dryRun": false,
                    "syncStrategy": { "apply": {} },
                },
                "initiatedBy": { "username": "skopos" },
            })
        );

        // What the controller writes once it starts the operation.
        let started = json!({ "status": { "operationState": {
            "operation": stored["operation"],
            "phase": "Running",
            "startedAt": "2026-11-01T09:00:00Z",
        } } });
        applications(&client, NAMESPACE)
            .patch("guestbook", &PatchParams::default(), &Patch::Merge(started))
            .await
            .unwrap();
        core.argocd_terminate(&id, NAMESPACE, "guestbook")
            .await
            .unwrap();
        let stored = read(&applications(&client, NAMESPACE), "guestbook").await;
        assert_eq!(stored["status"]["operationState"]["phase"], "Terminating");
        assert_eq!(stored["operation"]["initiatedBy"]["username"], "skopos");
    })
    .await;
}

#[tokio::test]
#[ignore = "needs the skopos-e2e kind cluster"]
async fn delete_keeps_other_finalizers_and_lets_a_stuck_application_go() {
    const NAMESPACE: &str = "skopos-test-argocd-delete";
    let (core, id, _root) = connected_kind().await;
    let client = core.cluster_client(&id).unwrap();
    with_applications(&client, NAMESPACE, async {
        let apps = applications(&client, NAMESPACE);
        let mut kept = application("kept", NAMESPACE);
        kept["metadata"]["finalizers"] = json!(["example.com/keep"]);
        create(&apps, kept).await;

        core.argocd_delete(&id, NAMESPACE, "kept", true)
            .await
            .unwrap();
        // No controller runs here, so the finalizers hold the Application.
        let stored = read(&apps, "kept").await;
        assert!(
            stored.pointer("/metadata/deletionTimestamp").is_some(),
            "{stored}"
        );
        assert_eq!(
            stored["metadata"]["finalizers"],
            json!(["example.com/keep", RESOURCES_FINALIZER])
        );
        // Already cascading: nothing to change, and no second delete.
        core.argocd_delete(&id, NAMESPACE, "kept", true)
            .await
            .unwrap();
        core.argocd_delete(&id, NAMESPACE, "kept", false)
            .await
            .unwrap();
        let stored = read(&apps, "kept").await;
        assert_eq!(
            stored["metadata"]["finalizers"],
            json!(["example.com/keep"])
        );

        // An Application whose controller is gone waits on the finalizer forever.
        let mut stuck = application("stuck", NAMESPACE);
        stuck["metadata"]["finalizers"] = json!([RESOURCES_FINALIZER]);
        create(&apps, stuck).await;
        apps.delete("stuck", &DeleteParams::default())
            .await
            .unwrap();
        core.argocd_delete(&id, NAMESPACE, "stuck", false)
            .await
            .unwrap();
        let started = Instant::now();
        while apps.get_opt("stuck").await.unwrap().is_some() {
            assert!(started.elapsed() < WAIT, "stuck is still there");
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await;
}

#[tokio::test]
#[ignore = "needs the skopos-e2e kind cluster"]
async fn refresh_sets_the_annotation_the_controller_reads() {
    const NAMESPACE: &str = "skopos-test-argocd-refresh";
    let (core, id, _root) = connected_kind().await;
    let client = core.cluster_client(&id).unwrap();
    with_applications(&client, NAMESPACE, async {
        let apps = applications(&client, NAMESPACE);
        create(&apps, application("guestbook", NAMESPACE)).await;
        let annotation = "/metadata/annotations/argocd.argoproj.io~1refresh";

        core.argocd_refresh(&id, NAMESPACE, "guestbook", true)
            .await
            .unwrap();
        assert_eq!(
            read(&apps, "guestbook").await.pointer(annotation),
            Some(&json!("hard"))
        );
        core.argocd_refresh(&id, NAMESPACE, "guestbook", false)
            .await
            .unwrap();
        assert_eq!(
            read(&apps, "guestbook").await.pointer(annotation),
            Some(&json!("normal"))
        );
    })
    .await;
}
