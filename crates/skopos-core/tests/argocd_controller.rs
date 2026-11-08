//! The Argo CD actions against a real Argo CD Core v3.6.1, which `make test-argocd` installs
//! on the `skopos-e2e` kind cluster. The Applications sync the public example repository of
//! the Argo CD project, so these tests need the network. Only `e2e/.tmp/kubeconfig` is read.

mod support;

use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::time::{Duration, Instant};

use futures::FutureExt;
use k8s_openapi::api::apps::v1::Deployment;
use kube::api::{ApiResource, DeleteParams, DynamicObject, Patch, PatchParams};
use kube::{Api, Client};
use serde_json::{json, Value};
use skopos_core::resources::{ArgoRollbackOptions, ArgoSyncOptions, ArgoSyncStrategy};
use support::{connected_kind, in_namespace};

const ARGOCD: &str = "argocd";
const PROJECT: &str = "skopos-test";
const REPO: &str = "https://github.com/argoproj/argocd-example-apps.git";
/// Two commits of that repository that both hold `guestbook/`.
const FIRST: &str = "8088f4c0d970abb09e250248cc97e35623447cb5";
const SECOND: &str = "0d521c6e049889134f3122eb32d7ed342f43ca0d";
/// A sync fetches the repository from the internet.
const WAIT: Duration = Duration::from_secs(300);

fn argo_api(client: &Client, kind: &str, plural: &str) -> Api<DynamicObject> {
    let resource = ApiResource {
        group: "argoproj.io".into(),
        version: "v1alpha1".into(),
        api_version: "argoproj.io/v1alpha1".into(),
        kind: kind.into(),
        plural: plural.into(),
    };
    Api::namespaced_with(client.clone(), ARGOCD, &resource)
}

fn applications(client: &Client) -> Api<DynamicObject> {
    argo_api(client, "Application", "applications")
}

/// Creates or updates, so a leftover of an earlier run is overwritten.
async fn apply(api: &Api<DynamicObject>, object: Value) {
    let name = object["metadata"]["name"].as_str().unwrap().to_owned();
    let object: DynamicObject = serde_json::from_value(object).unwrap();
    api.patch(
        &name,
        &PatchParams::apply("skopos-e2e").force(),
        &Patch::Apply(&object),
    )
    .await
    .unwrap();
}

async fn ensure_project(client: &Client) {
    let project = json!({
        "apiVersion": "argoproj.io/v1alpha1",
        "kind": "AppProject",
        "metadata": { "name": PROJECT, "namespace": ARGOCD },
        "spec": {
            "sourceRepos": [REPO],
            "destinations": [{ "server": "https://kubernetes.default.svc", "namespace": "skopos-test-argocd-*" }],
        },
    });
    apply(&argo_api(client, "AppProject", "appprojects"), project).await;
}

fn application(name: &str, destination: &str) -> Value {
    json!({
        "apiVersion": "argoproj.io/v1alpha1",
        "kind": "Application",
        "metadata": { "name": name, "namespace": ARGOCD },
        "spec": {
            "project": PROJECT,
            "source": { "repoURL": REPO, "path": "guestbook", "targetRevision": FIRST },
            "destination": { "server": "https://kubernetes.default.svc", "namespace": destination },
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

async fn read(client: &Client, name: &str) -> Option<Value> {
    applications(client)
        .get_opt(name)
        .await
        .unwrap()
        .map(|app| serde_json::to_value(app).unwrap())
}

/// Polls the Application once a second until `done` holds.
async fn wait_for(
    client: &Client,
    name: &str,
    what: &str,
    done: impl Fn(Option<&Value>) -> bool,
) -> Option<Value> {
    let started = Instant::now();
    loop {
        let app = read(client, name).await;
        if done(app.as_ref()) {
            return app;
        }
        assert!(
            started.elapsed() < WAIT,
            "{name}: no {what} within {WAIT:?}: {app:?}"
        );
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

fn phase(app: &Value) -> &str {
    app.pointer("/status/operationState/phase")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

/// Waits for the operation to end as the controller ends it: `operation` removed, and the
/// result in `status.operationState`.
async fn finished(client: &Client, name: &str) -> Value {
    let done = |app: Option<&Value>| {
        app.is_some_and(|app| {
            app.get("operation").is_none() && matches!(phase(app), "Succeeded" | "Failed" | "Error")
        })
    };
    wait_for(client, name, "finished operation", done)
        .await
        .unwrap()
}

/// Deletes an Application without its resources and waits until it is gone.
async fn remove_application(client: &Client, name: &str) {
    let apps = applications(client);
    if apps.get_opt(name).await.unwrap().is_none() {
        return;
    }
    let release = Patch::Merge(json!({ "metadata": { "finalizers": null } }));
    let _ = apps.patch(name, &PatchParams::default(), &release).await;
    let _ = apps.delete(name, &DeleteParams::default()).await;
    wait_for(client, name, "deletion", |app| app.is_none()).await;
}

/// Runs a test with the Application created in `argocd` and its destination namespace made
/// anew, and removes both afterwards, even if the test fails.
async fn with_application<Fut: Future<Output = ()>>(
    client: &Client,
    name: &str,
    destination: &str,
    app: Value,
    test: Fut,
) {
    ensure_project(client).await;
    remove_application(client, name).await;
    in_namespace(client, destination, async {
        apply(&applications(client), app).await;
        let result = AssertUnwindSafe(test).catch_unwind().await;
        remove_application(client, name).await;
        if let Err(panic) = result {
            std::panic::resume_unwind(panic);
        }
    })
    .await;
}

async fn deployment_exists(client: &Client, namespace: &str) -> bool {
    let deployments: Api<Deployment> = Api::namespaced(client.clone(), namespace);
    deployments.get_opt("guestbook-ui").await.unwrap().is_some()
}

#[tokio::test]
#[ignore = "needs Argo CD on the skopos-e2e kind cluster: make test-argocd"]
async fn a_sync_deploys_and_a_rollback_returns_to_the_first_revision() {
    const NAME: &str = "skopos-sync";
    const DESTINATION: &str = "skopos-test-argocd-sync";
    let (core, id, _root) = connected_kind().await;
    let client = core.cluster_client(&id).unwrap();
    let app = application(NAME, DESTINATION);
    with_application(&client, NAME, DESTINATION, app, async {
        core.argocd_sync(&id, ARGOCD, NAME, &plain_sync())
            .await
            .unwrap();
        let app = finished(&client, NAME).await;
        assert_eq!(phase(&app), "Succeeded", "{app}");
        assert!(deployment_exists(&client, DESTINATION).await);

        let to_second = ArgoSyncOptions {
            revision: Some(SECOND.into()),
            ..plain_sync()
        };
        core.argocd_sync(&id, ARGOCD, NAME, &to_second)
            .await
            .unwrap();
        let app = finished(&client, NAME).await;
        assert_eq!(phase(&app), "Succeeded", "{app}");
        assert_eq!(
            app["status"]["operationState"]["syncResult"]["revision"],
            SECOND
        );

        let first = app["status"]["history"][0].clone();
        assert_eq!(first["revision"], FIRST, "{app}");
        assert_eq!(first["initiatedBy"]["username"], "skopos", "{app}");
        let rollback = ArgoRollbackOptions {
            history_id: first["id"].as_i64().unwrap(),
            prune: false,
            dry_run: false,
            acknowledge_sync_windows: false,
        };
        core.argocd_rollback(&id, ARGOCD, NAME, &rollback)
            .await
            .unwrap();
        let app = finished(&client, NAME).await;
        assert_eq!(phase(&app), "Succeeded", "{app}");
        assert_eq!(
            app["status"]["operationState"]["syncResult"]["revision"],
            FIRST
        );
    })
    .await;
}

#[tokio::test]
#[ignore = "needs Argo CD on the skopos-e2e kind cluster: make test-argocd"]
async fn a_hard_refresh_is_taken_up_by_the_controller() {
    const NAME: &str = "skopos-refresh";
    const DESTINATION: &str = "skopos-test-argocd-refresh";
    let (core, id, _root) = connected_kind().await;
    let client = core.cluster_client(&id).unwrap();
    let app = application(NAME, DESTINATION);
    with_application(&client, NAME, DESTINATION, app, async {
        let reconciled = |app: Option<&Value>| {
            app.and_then(|app| app.pointer("/status/reconciledAt"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        };
        let app = wait_for(&client, NAME, "first comparison", |app| {
            reconciled(app).is_some()
        })
        .await;
        let before = reconciled(app.as_ref()).unwrap();
        // `reconciledAt` has whole seconds, so the next comparison must fall in a later one.
        tokio::time::sleep(Duration::from_millis(1100)).await;

        core.argocd_refresh(&id, ARGOCD, NAME, true).await.unwrap();
        let annotation = "/metadata/annotations/argocd.argoproj.io~1refresh";
        wait_for(&client, NAME, "refresh", |app| {
            app.is_some_and(|app| app.pointer(annotation).is_none())
                && reconciled(app).is_some_and(|at| at > before)
        })
        .await;
    })
    .await;
}

#[tokio::test]
#[ignore = "needs Argo CD on the skopos-e2e kind cluster: make test-argocd"]
async fn terminate_ends_an_operation_waiting_to_retry() {
    const NAME: &str = "skopos-terminate";
    const DESTINATION: &str = "skopos-test-argocd-terminate";
    let (core, id, _root) = connected_kind().await;
    let client = core.cluster_client(&id).unwrap();
    let mut app = application(NAME, DESTINATION);
    // A failed attempt waits an hour for the next one, and stays in progress meanwhile.
    app["spec"]["syncPolicy"] = json!({
        "retry": { "limit": 3, "backoff": { "duration": "1h", "factor": 1, "maxDuration": "1h" } },
    });
    with_application(&client, NAME, DESTINATION, app, async {
        let missing = ArgoSyncOptions {
            revision: Some("skopos-no-such-revision".into()),
            ..plain_sync()
        };
        core.argocd_sync(&id, ARGOCD, NAME, &missing).await.unwrap();
        wait_for(&client, NAME, "a retry waiting", |app| {
            app.is_some_and(|app| {
                app.get("operation").is_some()
                    && app
                        .pointer("/status/operationState/retryCount")
                        .and_then(Value::as_i64)
                        == Some(1)
            })
        })
        .await;

        core.argocd_terminate(&id, ARGOCD, NAME).await.unwrap();
        let app = finished(&client, NAME).await;
        assert_ne!(phase(&app), "Succeeded", "{app}");
        assert_eq!(app["status"]["operationState"]["retryCount"], 1, "{app}");
    })
    .await;
}

#[tokio::test]
#[ignore = "needs Argo CD on the skopos-e2e kind cluster: make test-argocd"]
async fn a_cascading_delete_removes_the_resources_and_a_plain_one_keeps_them() {
    const CASCADE: &str = "skopos-cascade";
    const PLAIN: &str = "skopos-plain";
    const DESTINATION: &str = "skopos-test-argocd-delete";
    let (core, id, _root) = connected_kind().await;
    let client = core.cluster_client(&id).unwrap();
    remove_application(&client, PLAIN).await;
    let app = application(CASCADE, DESTINATION);
    with_application(&client, CASCADE, DESTINATION, app, async {
        core.argocd_sync(&id, ARGOCD, CASCADE, &plain_sync())
            .await
            .unwrap();
        assert_eq!(phase(&finished(&client, CASCADE).await), "Succeeded");
        core.argocd_delete(&id, ARGOCD, CASCADE, true)
            .await
            .unwrap();
        wait_for(&client, CASCADE, "deletion", |app| app.is_none()).await;
        let started = Instant::now();
        while deployment_exists(&client, DESTINATION).await {
            assert!(started.elapsed() < WAIT, "the cascade left guestbook-ui");
            tokio::time::sleep(Duration::from_secs(1)).await;
        }

        apply(&applications(&client), application(PLAIN, DESTINATION)).await;
        core.argocd_sync(&id, ARGOCD, PLAIN, &plain_sync())
            .await
            .unwrap();
        assert_eq!(phase(&finished(&client, PLAIN).await), "Succeeded");
        core.argocd_delete(&id, ARGOCD, PLAIN, false).await.unwrap();
        wait_for(&client, PLAIN, "deletion", |app| app.is_none()).await;
        tokio::time::sleep(Duration::from_secs(5)).await;
        assert!(deployment_exists(&client, DESTINATION).await);
    })
    .await;
    remove_application(&client, PLAIN).await;
}
