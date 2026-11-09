//! Helm against a fake `helm`, a shell script that records its arguments. Real helm runs in
//! `kind_helm.rs`. The scripts need a Unix shell, so this file runs on Unix.
#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use skopos_core::app_core::AppCore;
use skopos_core::error::ErrorCode;
use skopos_core::helm::HelmHomes;
use skopos_core::paths::AppPaths;
use skopos_core::tools::{ToolSource, ToolsConfig};
use tempfile::TempDir;

/// A fake helm in its own folder. `helm version` prints `version`. Any other call appends
/// its arguments to `calls`, one per line and then a line `--`, and runs `body`. Each call
/// is appended with one write, so calls that run at once do not mix their lines.
struct FakeHelm {
    root: TempDir,
    calls: PathBuf,
}

impl FakeHelm {
    fn new(version: &str, body: &str) -> FakeHelm {
        let root = tempfile::tempdir().unwrap();
        let calls = root.path().join("calls");
        let script = format!(
            "#!/bin/sh\n\
             if [ \"$1\" = version ]; then printf '%s' '{version}'; exit 0; fi\n\
             record=''\n\
             for arg in \"$@\"; do record=\"$record$arg\n\"; done\n\
             printf '%s--\\n' \"$record\" >> '{calls}'\n\
             {body}\n",
            calls = calls.display(),
        );
        let bin = root.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("helm"), script).unwrap();
        std::fs::set_permissions(bin.join("helm"), std::fs::Permissions::from_mode(0o755)).unwrap();
        FakeHelm { root, calls }
    }

    fn path(&self) -> &Path {
        self.root.path()
    }

    /// Each call's arguments, oldest first. `helm version` is not recorded.
    fn calls(&self) -> Vec<Vec<String>> {
        let text = std::fs::read_to_string(&self.calls).unwrap_or_default();
        text.split_terminator("--\n")
            .map(|call| call.lines().map(str::to_owned).collect())
            .collect()
    }

    /// A core of its own that runs this helm.
    async fn core(&self) -> AppCore {
        let paths = AppPaths::under(&self.path().join("app"), &self.path().join("home"));
        let core = AppCore::start_with_kubeconfig_env(paths, None)
            .await
            .unwrap();
        self.configure(&core);
        core
    }

    /// Makes `core` find this helm and no other, with helm's folders in this temp dir.
    fn configure(&self, core: &AppCore) {
        core.set_tools_config_for_test(ToolsConfig {
            search_path: Some(self.path().join("bin").into_os_string()),
            ..ToolsConfig::default()
        });
        core.set_helm_homes_for_test(HelmHomes {
            config: self.path().join("helm/config"),
            cache: self.path().join("helm/cache"),
            data: self.path().join("helm/data"),
        });
    }
}

#[tokio::test]
async fn helm_4_reports_its_path_version_and_major() {
    let helm = FakeHelm::new("v4.3.1", "exit 0");
    let core = helm.core().await;
    let info = core.helm_version().await.unwrap();
    assert_eq!(info.version, "v4.3.1");
    assert_eq!(info.major, 4);
    assert_eq!(info.source, ToolSource::Path);
    assert_eq!(Path::new(&info.path), helm.path().join("bin/helm"));
    assert!(helm.calls().is_empty(), "{:?}", helm.calls());
    core.shutdown().await;
}

#[tokio::test]
async fn helm_3_reports_major_3() {
    let helm = FakeHelm::new("v3.22.1", "exit 0");
    let core = helm.core().await;
    assert_eq!(core.helm_version().await.unwrap().major, 3);
    core.shutdown().await;
}

#[tokio::test]
async fn a_helm_older_than_3_13_is_tool_missing() {
    let helm = FakeHelm::new("v3.12.3", "exit 0");
    let core = helm.core().await;
    let error = core.helm_version().await.unwrap_err();
    assert_eq!(error.code, ErrorCode::ToolMissing);
    assert_eq!(error.details.as_deref(), Some("helm"));
    assert!(error.message.contains("3.13"), "{}", error.message);
    core.shutdown().await;
}

#[tokio::test]
async fn no_helm_is_tool_missing() {
    let helm = FakeHelm::new("v4.3.1", "exit 0");
    let core = helm.core().await;
    core.set_tools_config_for_test(ToolsConfig {
        search_path: Some(helm.path().join("empty").into_os_string()),
        ..ToolsConfig::default()
    });
    let error = core.helm_version().await.unwrap_err();
    assert_eq!(error.code, ErrorCode::ToolMissing);
    assert_eq!(error.details.as_deref(), Some("helm"));
    core.shutdown().await;
}
