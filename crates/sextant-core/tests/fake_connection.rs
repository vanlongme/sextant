//! The connection lifecycle against the fake API server, with a real `kube` client.
//! Every kubeconfig lives in a temp `<home>/.kube`; `KUBECONFIG` is never read.

use std::future::Future;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use sextant_core::app_core::{AppCore, CoreEvent};
use sextant_core::cluster::{ConnectTimeouts, ConnectionState, FailureKind, LogLevel};
use sextant_core::error::ErrorCode;
use sextant_core::kubeconfig::ClusterId;
use sextant_core::paths::AppPaths;
use sextant_core::prefs::ClusterSettings;
use sextant_fakekube::{FakeKube, FakeKubeConfig};
use tempfile::TempDir;

const CONTEXT: &str = "fake";
const LIMIT: Duration = Duration::from_secs(3);

fn paths_in(root: &TempDir) -> AppPaths {
    AppPaths::under(&root.path().join("app"), &root.path().join("home"))
}

fn kube_dir(root: &TempDir) -> PathBuf {
    let dir = root.path().join("home").join(".kube");
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn kube_config(root: &TempDir) -> PathBuf {
    kube_dir(root).join("config")
}

async fn start_core(root: &TempDir) -> AppCore {
    AppCore::start_with_kubeconfig_env(paths_in(root), None)
        .await
        .unwrap()
}

/// Polls `check`, which cannot be replaced by an event for every condition tested here.
async fn wait_until<F, Fut>(what: &str, mut check: F)
where
    F: FnMut() -> Fut,
    Fut: Future<Output = bool>,
{
    let started = Instant::now();
    while !check().await {
        assert!(started.elapsed() < LIMIT, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn wait_for_entry(core: &AppCore, context: &str) -> ClusterId {
    wait_until(&format!("catalog entry {context}"), || async {
        core.catalog_list()
            .iter()
            .any(|entry| entry.context_name == context)
    })
    .await;
    let entries = core.catalog_list();
    let entry = entries.iter().find(|entry| entry.context_name == context);
    entry.unwrap().id.clone()
}

async fn core_with_kubeconfig(text: &str) -> (AppCore, ClusterId, TempDir) {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(kube_config(&root), text).unwrap();
    let core = start_core(&root).await;
    let id = wait_for_entry(&core, CONTEXT).await;
    (core, id, root)
}

async fn core_with_fake(cfg: FakeKubeConfig) -> (AppCore, FakeKube, ClusterId, TempDir) {
    let fake = FakeKube::start(cfg).await.unwrap();
    let root = tempfile::tempdir().unwrap();
    fake.write_kubeconfig(&kube_config(&root), CONTEXT).unwrap();
    let core = start_core(&root).await;
    let id = wait_for_entry(&core, CONTEXT).await;
    (core, fake, id, root)
}

/// One context named `CONTEXT`, whose user and namespace are given as YAML.
fn config_text(server: &str, user: &str, namespace: Option<&str>) -> String {
    let namespace = namespace.map_or(String::new(), |n| format!(", namespace: {n}"));
    format!(
        "apiVersion: v1\nkind: Config\n\
         clusters:\n- {{ name: c1, cluster: {{ server: \"{server}\" }} }}\n\
         users:\n- name: u1\n  user: {user}\n\
         contexts:\n- {{ name: {CONTEXT}, context: {{ cluster: c1, user: u1{namespace} }} }}\n\
         current-context: {CONTEXT}\n"
    )
}

const TOKEN_USER: &str = "{ token: fake-token }";

fn exec_user(command: &str, args: &[&str]) -> String {
    let args: Vec<String> = args
        .iter()
        .map(|arg| serde_json::to_string(arg).unwrap())
        .collect();
    format!(
        "{{ exec: {{ apiVersion: client.authentication.k8s.io/v1, command: \"{command}\", \
         args: [{}], interactiveMode: Never }} }}",
        args.join(", ")
    )
}

fn failure(state: &ConnectionState) -> (FailureKind, &str) {
    match state {
        ConnectionState::Failed { kind, message } => (*kind, message),
        other => panic!("expected Failed, got {other:?}"),
    }
}

fn namespaces(state: &ConnectionState) -> (&[String], bool) {
    match state {
        ConnectionState::Connected { info } => (&info.namespaces, info.namespaces_restricted),
        other => panic!("expected Connected, got {other:?}"),
    }
}

#[tokio::test]
async fn connect_success_reaches_connected_and_logs_each_step() {
    let (core, _fake, id, _root) = core_with_fake(FakeKubeConfig::default()).await;

    let state = core.cluster_connect(&id).await.unwrap();

    let ConnectionState::Connected { info } = &state else {
        panic!("expected Connected, got {state:?}");
    };
    assert_eq!(info.version, "v1.37.0");
    assert_eq!(info.namespaces, ["default", "kube-system"]);
    assert!(!info.namespaces_restricted);
    assert_eq!(info.distribution, "Kubernetes");
    assert!(info.is_admin);
    assert_eq!(core.cluster_state(&id), state);

    let log = core.cluster_log(&id);
    let mut remaining = log.iter();
    for step in [
        "client",
        "version",
        "discovery",
        "namespaces",
        "access",
        "metadata",
    ] {
        assert!(
            remaining.any(|entry| entry.message.contains(step)),
            "no {step} after the previous step in {log:?}"
        );
    }

    let listed = core.catalog_list();
    assert_eq!(listed[0].state, state);
    core.cluster_client(&id).unwrap();
    let discovery = core.cluster_discovery(&id).unwrap();
    assert!(discovery.has_group("apps"));
}

#[tokio::test]
async fn connecting_an_unknown_id_is_not_found() {
    let (core, _fake, _id, _root) = core_with_fake(FakeKubeConfig::default()).await;

    let err = core.cluster_connect(&"nope".to_owned()).await.unwrap_err();

    assert_eq!(err.code, ErrorCode::NotFound);
}

#[tokio::test]
async fn connection_resources_are_not_available_while_disconnected() {
    let (core, _fake, id, _root) = core_with_fake(FakeKubeConfig::default()).await;

    assert_eq!(core.cluster_state(&id), ConnectionState::Disconnected);
    assert!(core.cluster_client(&id).is_err());
    assert!(core.cluster_kubeconfig_path(&id).is_err());
    assert!(core.cluster_cancel_token(&id).is_err());
    assert!(core.cluster_discovery(&id).is_err());
}

#[tokio::test]
async fn unauthorized_maps_to_failed_unauthorized() {
    let (core, _fake, id, _root) = core_with_fake(FakeKubeConfig {
        unauthorized: true,
        ..Default::default()
    })
    .await;

    let state = core.cluster_connect(&id).await.unwrap();

    let (kind, message) = failure(&state);
    assert_eq!(kind, FailureKind::Unauthorized);
    assert!(message.contains("Unauthorized"), "{message}");
    let log = core.cluster_log(&id);
    assert!(
        log.iter()
            .any(|entry| matches!(entry.level, LogLevel::Error) && entry.message == message),
        "{log:?}"
    );
}

#[tokio::test]
async fn closed_port_maps_to_failed_unreachable() {
    let (core, fake, id, _root) = core_with_fake(FakeKubeConfig::default()).await;
    fake.shutdown().await;

    let state = core.cluster_connect(&id).await.unwrap();

    let (kind, message) = failure(&state);
    assert_eq!(kind, FailureKind::Unreachable);
    assert!(message.starts_with("Connection refused"), "{message}");
    assert!(!message.contains("ServiceError"), "{message}");
}

#[tokio::test]
async fn slow_version_times_out_as_unreachable() {
    let (core, _fake, id, _root) = core_with_fake(FakeKubeConfig {
        version_delay: Duration::from_secs(5),
        ..Default::default()
    })
    .await;
    core.set_connect_timeouts_for_test(ConnectTimeouts {
        version: Duration::from_millis(200),
        ..Default::default()
    });
    let started = Instant::now();

    let state = core.cluster_connect(&id).await.unwrap();

    let (kind, message) = failure(&state);
    assert_eq!(kind, FailureKind::Unreachable);
    assert!(message.contains("timed out"), "{message}");
    assert!(started.elapsed() < LIMIT);
}

#[tokio::test]
async fn missing_exec_plugin_fails_and_names_the_command() {
    let text = config_text(
        "http://127.0.0.1:9",
        &exec_user("/nonexistent/auth-plugin", &[]),
        None,
    );
    let (core, id, _root) = core_with_kubeconfig(&text).await;

    let state = tokio::time::timeout(Duration::from_secs(10), core.cluster_connect(&id))
        .await
        .expect("a missing plugin must not hang")
        .unwrap();

    let (kind, message) = failure(&state);
    assert_eq!(kind, FailureKind::Other);
    assert!(message.contains("auth-plugin"), "{message}");
}

#[cfg(unix)]
#[tokio::test]
async fn failing_exec_plugin_reports_the_command_and_its_stderr() {
    let text = config_text(
        "http://127.0.0.1:9",
        &exec_user("/bin/sh", &["-c", "echo no-such-profile >&2; exit 3"]),
        None,
    );
    let (core, id, _root) = core_with_kubeconfig(&text).await;

    let state = core.cluster_connect(&id).await.unwrap();

    let (kind, message) = failure(&state);
    assert_eq!(kind, FailureKind::Other);
    assert!(message.contains("auth plugin \"sh\""), "{message}");
    assert!(message.contains("no-such-profile"), "{message}");
}

#[cfg(unix)]
#[tokio::test]
async fn failing_exec_plugin_does_not_leak_secrets_to_state_or_log() {
    use std::os::unix::fs::PermissionsExt;
    let scripts = tempfile::tempdir().unwrap();
    let script = scripts.path().join("auth-plugin");
    std::fs::write(
        &script,
        "#!/bin/sh\n\
         echo '{\"token\":\"S3CRET-STDOUT\"}'\n\
         echo 'Authorization: Bearer S3CRET-STDERR' >&2\n\
         echo 'please run login' >&2\n\
         exit 1\n",
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    // A real `kube` error carries the arguments and the environment in `cmd`.
    let user = format!(
        "{{ exec: {{ apiVersion: client.authentication.k8s.io/v1, command: \"{}\", \
         args: [--secret-arg, S3CRET-ARG], env: [{{ name: PLUGIN_ENV, value: S3CRET-ENV }}], \
         interactiveMode: Never }} }}",
        script.display()
    );
    let text = config_text("http://127.0.0.1:9", &user, None);
    let (core, id, _root) = core_with_kubeconfig(&text).await;

    let state = core.cluster_connect(&id).await.unwrap();

    let (_, message) = failure(&state);
    assert!(message.contains("auth-plugin"), "{message}");
    let state_json = serde_json::to_string(&state).unwrap();
    let log_json = serde_json::to_string(&core.cluster_log(&id)).unwrap();
    for secret in ["S3CRET-STDOUT", "S3CRET-STDERR", "S3CRET-ARG", "S3CRET-ENV"] {
        assert!(!state_json.contains(secret), "{secret} in {state_json}");
        assert!(!log_json.contains(secret), "{secret} in {log_json}");
    }
    assert!(
        message.contains("please run login") || log_json.contains("please run login"),
        "{state_json} {log_json}"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn exec_plugin_printing_garbage_does_not_leak_it() {
    let text = config_text(
        "http://127.0.0.1:9",
        &exec_user("/bin/sh", &["-c", "echo 'S3CRET-STDOUT: [unterminated'"]),
        None,
    );
    let (core, id, _root) = core_with_kubeconfig(&text).await;

    let state = core.cluster_connect(&id).await.unwrap();

    let state_json = serde_json::to_string(&state).unwrap();
    let log_json = serde_json::to_string(&core.cluster_log(&id)).unwrap();
    assert!(!state_json.contains("S3CRET-STDOUT"), "{state_json}");
    assert!(!log_json.contains("S3CRET-STDOUT"), "{log_json}");
}

/// `kube` runs the plugin while building the client, before any request.
#[cfg(unix)]
#[tokio::test]
async fn hanging_exec_plugin_times_out_and_names_the_command() {
    // Short, because dropping the test's runtime waits for the blocking call.
    let text = config_text(
        "http://127.0.0.1:9",
        &exec_user("/bin/sh", &["-c", "sleep 2"]),
        None,
    );
    let (core, id, _root) = core_with_kubeconfig(&text).await;
    core.set_connect_timeouts_for_test(ConnectTimeouts {
        version_exec: Duration::from_millis(200),
        ..Default::default()
    });
    let started = Instant::now();

    let state = core.cluster_connect(&id).await.unwrap();

    assert!(started.elapsed() < Duration::from_secs(1));
    let (kind, message) = failure(&state);
    assert_eq!(kind, FailureKind::Unreachable);
    assert!(message.contains("timed out"), "{message}");
    assert!(message.contains("/bin/sh"), "{message}");
}

#[cfg(unix)]
#[tokio::test]
async fn working_exec_plugin_connects() {
    let fake = FakeKube::start(FakeKubeConfig::default()).await.unwrap();
    let credential = "echo '{\"apiVersion\":\"client.authentication.k8s.io/v1\",\
        \"kind\":\"ExecCredential\",\"status\":{\"token\":\"from-plugin\"}}'";
    let text = config_text(
        &fake.url(),
        &exec_user("/bin/sh", &["-c", credential]),
        None,
    );
    let (core, id, _root) = core_with_kubeconfig(&text).await;

    let state = core.cluster_connect(&id).await.unwrap();

    assert!(
        matches!(state, ConnectionState::Connected { .. }),
        "{state:?}"
    );
}

#[tokio::test]
async fn invalid_context_reference_fails_as_config_invalid() {
    let fake = FakeKube::start(FakeKubeConfig::default()).await.unwrap();
    let text = format!(
        "apiVersion: v1\nkind: Config\n\
         clusters:\n- {{ name: c1, cluster: {{ server: \"{}\" }} }}\n\
         users:\n- {{ name: u1, user: {{ token: t }} }}\n\
         contexts:\n- {{ name: {CONTEXT}, context: {{ cluster: gone, user: u1 }} }}\n",
        fake.url()
    );
    let (core, id, root) = core_with_kubeconfig(&text).await;

    let state = core.cluster_connect(&id).await.unwrap();

    let (kind, message) = failure(&state);
    assert_eq!(kind, FailureKind::ConfigInvalid);
    assert!(message.contains("gone"), "{message}");
    assert_eq!(fake.request_count("/version"), 0);
    let runtime = paths_in(&root).data.join("runtime");
    assert!(!runtime.join(format!("{id}.yaml")).exists());
}

#[tokio::test]
async fn namespace_forbidden_falls_back_to_accessible_setting() {
    let (core, _fake, id, _root) = core_with_fake(FakeKubeConfig {
        forbid_namespace_list: true,
        ..Default::default()
    })
    .await;
    core.cluster_settings_set(
        &id,
        ClusterSettings {
            accessible_namespaces: vec!["a".into(), "b".into()],
            ..Default::default()
        },
    )
    .unwrap();

    let state = core.cluster_connect(&id).await.unwrap();

    let (names, restricted) = namespaces(&state);
    assert_eq!(names, ["a", "b"]);
    assert!(restricted);
    let log = core.cluster_log(&id);
    assert!(
        log.iter()
            .any(|entry| matches!(entry.level, LogLevel::Warn)
                && entry.message.contains("namespaces")),
        "{log:?}"
    );
}

#[tokio::test]
async fn namespace_forbidden_falls_back_to_context_namespace() {
    let fake = FakeKube::start(FakeKubeConfig {
        forbid_namespace_list: true,
        ..Default::default()
    })
    .await
    .unwrap();
    let text = config_text(&fake.url(), TOKEN_USER, Some("ctxns"));
    let (core, id, _root) = core_with_kubeconfig(&text).await;

    let state = core.cluster_connect(&id).await.unwrap();

    let (names, restricted) = namespaces(&state);
    assert_eq!(names, ["ctxns"]);
    assert!(restricted);
}

#[tokio::test]
async fn namespace_forbidden_with_nothing_configured_uses_default() {
    let (core, _fake, id, _root) = core_with_fake(FakeKubeConfig {
        forbid_namespace_list: true,
        ..Default::default()
    })
    .await;

    let state = core.cluster_connect(&id).await.unwrap();

    let (names, restricted) = namespaces(&state);
    assert_eq!(names, ["default"]);
    assert!(restricted);
}

#[tokio::test]
async fn servers_without_aggregated_discovery_use_the_per_group_endpoints() {
    let (core, fake, id, _root) = core_with_fake(FakeKubeConfig {
        no_aggregated_discovery: true,
        ..Default::default()
    })
    .await;

    let state = core.cluster_connect(&id).await.unwrap();

    assert!(
        matches!(state, ConnectionState::Connected { .. }),
        "{state:?}"
    );
    assert!(fake.request_count("/apis/apps/v1") > 0);
    assert!(core.cluster_discovery(&id).unwrap().has_group("apps"));
}

#[tokio::test]
async fn disconnect_during_connect_cancels_without_stale_state() {
    let (core, _fake, id, _root) = core_with_fake(FakeKubeConfig {
        version_delay: Duration::from_secs(2),
        ..Default::default()
    })
    .await;
    let mut events = core.subscribe();
    let connecting = {
        let core = core.clone();
        let id = id.clone();
        tokio::spawn(async move { core.cluster_connect(&id).await })
    };
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(core.cluster_state(&id), ConnectionState::Connecting);

    core.cluster_disconnect(&id).await.unwrap();

    assert_eq!(core.cluster_state(&id), ConnectionState::Disconnected);
    assert_eq!(
        connecting.await.unwrap().unwrap(),
        ConnectionState::Disconnected
    );
    tokio::time::sleep(LIMIT).await;
    assert_eq!(core.cluster_state(&id), ConnectionState::Disconnected);
    let mut last = None;
    while let Ok(event) = events.try_recv() {
        if let CoreEvent::ClusterState { state, .. } = event {
            last = Some(state);
        }
    }
    assert_eq!(last, Some(ConnectionState::Disconnected));
}

#[tokio::test]
async fn connect_is_idempotent_and_concurrent_calls_share_one_attempt() {
    let (core, fake, id, _root) = core_with_fake(FakeKubeConfig::default()).await;

    let (first, second) = tokio::join!(core.cluster_connect(&id), core.cluster_connect(&id));

    let first = first.unwrap();
    assert!(
        matches!(first, ConnectionState::Connected { .. }),
        "{first:?}"
    );
    assert_eq!(second.unwrap(), first);
    assert_eq!(fake.request_count("/version"), 1);

    let third = core.cluster_connect(&id).await.unwrap();

    assert_eq!(third, first);
    assert_eq!(fake.request_count("/version"), 1);
}

#[tokio::test]
async fn concurrent_calls_share_a_failed_attempt() {
    let (core, fake, id, _root) = core_with_fake(FakeKubeConfig {
        unauthorized: true,
        ..Default::default()
    })
    .await;

    let (first, second) = tokio::join!(core.cluster_connect(&id), core.cluster_connect(&id));

    assert_eq!(first.unwrap(), second.unwrap());
    assert_eq!(fake.request_count("/version"), 1);
}

#[tokio::test]
async fn disconnect_deletes_per_context_kubeconfig_and_reconnect_recreates() {
    let (core, _fake, id, root) = core_with_fake(FakeKubeConfig::default()).await;

    core.cluster_connect(&id).await.unwrap();

    let path = core.cluster_kubeconfig_path(&id).unwrap();
    assert_eq!(
        path,
        paths_in(&root)
            .data
            .join("runtime")
            .join(format!("{id}.yaml"))
    );
    assert!(path.exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    let token = core.cluster_cancel_token(&id).unwrap();
    assert!(!token.is_cancelled());

    core.cluster_disconnect(&id).await.unwrap();

    assert!(!path.exists());
    assert!(token.is_cancelled());
    assert!(core.cluster_kubeconfig_path(&id).is_err());

    let state = core.cluster_connect(&id).await.unwrap();

    assert!(
        matches!(state, ConnectionState::Connected { .. }),
        "{state:?}"
    );
    assert!(path.exists());
    assert!(!core.cluster_cancel_token(&id).unwrap().is_cancelled());
}

#[tokio::test]
async fn cancelling_a_handed_out_token_leaves_the_cluster_connected() {
    let (core, _fake, id, _root) = core_with_fake(FakeKubeConfig::default()).await;
    core.cluster_connect(&id).await.unwrap();

    core.cluster_cancel_token(&id).unwrap().cancel();

    assert!(!core.cluster_cancel_token(&id).unwrap().is_cancelled());
    assert!(matches!(
        core.cluster_state(&id),
        ConnectionState::Connected { .. }
    ));
}

#[tokio::test]
async fn a_failed_connect_leaves_no_kubeconfig_and_can_be_retried() {
    let (core, fake, id, root) = core_with_fake(FakeKubeConfig {
        unauthorized: true,
        ..Default::default()
    })
    .await;

    core.cluster_connect(&id).await.unwrap();

    let path = paths_in(&root)
        .data
        .join("runtime")
        .join(format!("{id}.yaml"));
    assert!(!path.exists());

    core.cluster_connect(&id).await.unwrap();

    assert_eq!(fake.request_count("/version"), 2);
}

#[tokio::test]
async fn two_clusters_are_independent() {
    let good = FakeKube::start(FakeKubeConfig::default()).await.unwrap();
    let bad = FakeKube::start(FakeKubeConfig {
        unauthorized: true,
        ..Default::default()
    })
    .await
    .unwrap();
    let root = tempfile::tempdir().unwrap();
    good.write_kubeconfig(&kube_dir(&root).join("good"), "good")
        .unwrap();
    bad.write_kubeconfig(&kube_dir(&root).join("bad"), "bad")
        .unwrap();
    let core = start_core(&root).await;
    let good_id = wait_for_entry(&core, "good").await;
    let bad_id = wait_for_entry(&core, "bad").await;

    let good_state = core.cluster_connect(&good_id).await.unwrap();
    let bad_state = core.cluster_connect(&bad_id).await.unwrap();

    assert!(matches!(good_state, ConnectionState::Connected { .. }));
    assert_eq!(failure(&bad_state).0, FailureKind::Unauthorized);
    assert_eq!(core.cluster_state(&good_id), good_state);

    core.cluster_disconnect(&bad_id).await.unwrap();

    assert_eq!(core.cluster_state(&bad_id), ConnectionState::Disconnected);
    assert_eq!(core.cluster_state(&good_id), good_state);
    core.cluster_client(&good_id).unwrap();
}

#[tokio::test]
async fn removing_context_from_file_disconnects_it() {
    let (core, fake, id, root) = core_with_fake(FakeKubeConfig::default()).await;
    core.cluster_connect(&id).await.unwrap();
    let path = core.cluster_kubeconfig_path(&id).unwrap();

    fake.write_kubeconfig(&kube_config(&root), "other").unwrap();

    wait_until("the entry to go and the state to clear", || async {
        !core.catalog_list().iter().any(|entry| entry.id == id)
            && core.cluster_state(&id) == ConnectionState::Disconnected
    })
    .await;
    assert!(!path.exists());
}

#[tokio::test]
async fn stale_per_context_files_are_removed_at_startup() {
    let root = tempfile::tempdir().unwrap();
    let runtime = paths_in(&root).data.join("runtime");
    std::fs::create_dir_all(runtime.join("nested")).unwrap();
    std::fs::write(runtime.join("stale.yaml"), "secret").unwrap();
    std::fs::write(runtime.join("nested").join("stale.yaml"), "secret").unwrap();

    let _core = start_core(&root).await;

    assert!(!runtime.join("stale.yaml").exists());
    assert!(!runtime.join("nested").exists());
}

#[tokio::test]
async fn shutdown_disconnects_every_cluster() {
    let (core, _fake, id, _root) = core_with_fake(FakeKubeConfig::default()).await;
    core.cluster_connect(&id).await.unwrap();
    let path = core.cluster_kubeconfig_path(&id).unwrap();

    core.shutdown().await;

    assert_eq!(core.cluster_state(&id), ConnectionState::Disconnected);
    assert!(!path.exists());
}

#[tokio::test]
async fn proxy_url_setting_is_applied() {
    let (core, fake, id, _root) = core_with_fake(FakeKubeConfig::default()).await;
    core.cluster_settings_set(
        &id,
        ClusterSettings {
            proxy_url: Some("foo://user:hunter2@x".into()),
            ..Default::default()
        },
    )
    .unwrap();

    let state = core.cluster_connect(&id).await.unwrap();

    let (kind, message) = failure(&state);
    assert_eq!(kind, FailureKind::ConfigInvalid);
    assert!(message.contains("proxy"), "{message}");
    assert!(!message.contains("hunter2"), "{message}");
    assert_eq!(fake.request_count("/version"), 0);
}

#[tokio::test]
async fn unparsable_proxy_url_setting_is_config_invalid() {
    let (core, _fake, id, _root) = core_with_fake(FakeKubeConfig::default()).await;
    core.cluster_settings_set(
        &id,
        ClusterSettings {
            proxy_url: Some("not a url".into()),
            ..Default::default()
        },
    )
    .unwrap();

    let state = core.cluster_connect(&id).await.unwrap();

    let (kind, message) = failure(&state);
    assert_eq!(kind, FailureKind::ConfigInvalid);
    assert!(message.contains("proxy"), "{message}");
}
