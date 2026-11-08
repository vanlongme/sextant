//! Finding helm and kubectl and reading their versions (F14). The tools here are shell
//! scripts, so this file runs on Unix; the lookup order itself is unit tested on every OS.
#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use skopos_core::app_core::AppCore;
use skopos_core::error::ErrorCode;
use skopos_core::paths::AppPaths;
use skopos_core::prefs::Prefs;
use skopos_core::tools::pinned::{HELM_VERSION, KUBECTL_VERSION};
use skopos_core::tools::{ToolName, ToolSource, ToolsConfig};
use tempfile::TempDir;

async fn start(root: &TempDir, search_path: &Path) -> AppCore {
    let paths = AppPaths::under(&root.path().join("app"), &root.path().join("home"));
    let core = AppCore::start_with_kubeconfig_env(paths, None)
        .await
        .unwrap();
    core.set_tools_config_for_test(ToolsConfig {
        search_path: Some(search_path.as_os_str().to_owned()),
        ..ToolsConfig::default()
    });
    core
}

fn write_script(path: &Path, body: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

#[tokio::test]
async fn helm_on_path_is_found_and_its_version_is_read_once() {
    let root = tempfile::tempdir().unwrap();
    let bin = root.path().join("bin");
    let calls = root.path().join("calls");
    let body = format!("echo \"$@\" >> '{}'\nprintf v4.3.1", calls.display());
    write_script(&bin.join("helm"), &body);
    let core = start(&root, &bin).await;

    let helm = core.tool_status(ToolName::Helm).await;
    assert_eq!(helm.source, ToolSource::Path);
    assert_eq!(helm.path.as_deref(), bin.join("helm").to_str());
    assert_eq!(helm.version.as_deref(), Some("v4.3.1"));
    assert_eq!(helm.problem, None);
    assert!(!helm.downloading);
    core.tools_status().await;
    let calls = std::fs::read_to_string(&calls).unwrap();
    assert_eq!(
        calls.lines().collect::<Vec<_>>(),
        ["version --template {{.Version}}"]
    );
    core.shutdown().await;
}

#[tokio::test]
async fn a_changed_binary_is_asked_again() {
    let root = tempfile::tempdir().unwrap();
    let bin = root.path().join("bin");
    write_script(&bin.join("helm"), "printf v4.3.1");
    let core = start(&root, &bin).await;
    assert_eq!(
        core.tool_status(ToolName::Helm).await.version.as_deref(),
        Some("v4.3.1")
    );
    write_script(&bin.join("helm"), "printf v4.10.0");
    assert_eq!(
        core.tool_status(ToolName::Helm).await.version.as_deref(),
        Some("v4.10.0")
    );
    core.shutdown().await;
}

#[tokio::test]
async fn a_preferences_path_that_does_not_exist_is_a_problem_and_ends_the_lookup() {
    let root = tempfile::tempdir().unwrap();
    let bin = root.path().join("bin");
    write_script(&bin.join("helm"), "printf v4.3.1");
    let core = start(&root, &bin).await;
    let missing = root.path().join("missing/helm");
    core.prefs_set(Prefs {
        helm_path: Some(missing.to_string_lossy().into_owned()),
        ..core.prefs_get()
    })
    .unwrap();

    let helm = core.tool_status(ToolName::Helm).await;
    assert_eq!(helm.source, ToolSource::Preferences);
    assert_eq!(helm.version, None);
    assert!(
        helm.problem
            .as_deref()
            .unwrap_or_default()
            .contains("does not exist"),
        "{helm:?}"
    );
    let error = core.tool_resolve(ToolName::Helm).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::ToolMissing);
    assert_eq!(error.details.as_deref(), Some("helm"));
    assert!(error.message.contains("does not exist"), "{error:?}");
    core.shutdown().await;
}

#[tokio::test]
async fn the_managed_copy_is_used_when_path_has_none() {
    let root = tempfile::tempdir().unwrap();
    let empty = root.path().join("empty");
    std::fs::create_dir(&empty).unwrap();
    let managed = root
        .path()
        .join("app/data/tools/kubectl")
        .join(KUBECTL_VERSION)
        .join("kubectl");
    let json = format!("printf '{{\"clientVersion\":{{\"gitVersion\":\"{KUBECTL_VERSION}\"}}}}'");
    write_script(&managed, &json);
    let core = start(&root, &empty).await;

    let kubectl = core.tool_status(ToolName::Kubectl).await;
    assert_eq!(kubectl.source, ToolSource::Managed);
    assert_eq!(kubectl.path.as_deref(), managed.to_str());
    assert_eq!(kubectl.version.as_deref(), Some(KUBECTL_VERSION));
    assert_eq!(kubectl.managed_version.as_deref(), Some(KUBECTL_VERSION));
    assert!(kubectl.managed_installed);
    let resolved = core.tool_resolve(ToolName::Kubectl).await.unwrap();
    assert_eq!(
        (resolved.path, resolved.source),
        (managed, ToolSource::Managed)
    );
    core.shutdown().await;
}

#[tokio::test]
async fn a_tool_found_nowhere_is_missing_and_offers_the_managed_version() {
    let root = tempfile::tempdir().unwrap();
    let core = start(&root, Path::new("")).await;
    let helm = core.tool_status(ToolName::Helm).await;
    assert_eq!(helm.source, ToolSource::Missing);
    assert_eq!((helm.path, helm.version, helm.problem), (None, None, None));
    assert_eq!(helm.managed_version.as_deref(), Some(HELM_VERSION));
    assert!(!helm.managed_installed);
    let error = core.tool_resolve(ToolName::Helm).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::ToolMissing);
    assert_eq!(error.details.as_deref(), Some("helm"));
    assert!(error.message.contains("not found"), "{error:?}");
    core.shutdown().await;
}

#[tokio::test]
async fn a_binary_whose_version_fails_says_why() {
    let root = tempfile::tempdir().unwrap();
    let bin = root.path().join("bin");
    write_script(&bin.join("helm"), "echo 'Error: boom' >&2\nexit 1");
    let core = start(&root, &bin).await;
    let helm = core.tool_status(ToolName::Helm).await;
    assert_eq!(
        (helm.source, helm.version.as_deref()),
        (ToolSource::Path, None)
    );
    assert!(
        helm.problem.as_deref().unwrap_or_default().contains("boom"),
        "{helm:?}"
    );
    let error = core.tool_resolve(ToolName::Helm).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::ToolMissing);
    core.shutdown().await;
}

#[tokio::test]
async fn prefs_set_refuses_a_proxy_that_is_not_http_and_trims_the_rest() {
    let root = tempfile::tempdir().unwrap();
    let core = start(&root, Path::new("")).await;
    let error = core
        .prefs_set(Prefs {
            http_proxy: Some("socks5://proxy.example:1080".into()),
            ..core.prefs_get()
        })
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
    core.prefs_set(Prefs {
        http_proxy: Some(" http://proxy.example:3128 ".into()),
        kubectl_path: Some("   ".into()),
        ..core.prefs_get()
    })
    .unwrap();
    let saved = core.prefs_get();
    assert_eq!(
        saved.http_proxy.as_deref(),
        Some("http://proxy.example:3128")
    );
    assert_eq!(saved.kubectl_path, None);
    core.shutdown().await;
}
