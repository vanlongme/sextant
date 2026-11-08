//! The real pinned helm and kubectl, downloaded from the official hosts into
//! `e2e/.tmp/tools`, where later runs find them in place and download nothing. The first run
//! needs the network. Run with `make test-kind`.

use std::ffi::OsString;
use std::path::Path;
use std::time::Duration;

use skopos_core::app_core::AppCore;
use skopos_core::paths::AppPaths;
use skopos_core::process::{run, Output, ProcessSpec};
use skopos_core::tools::pinned::{HELM_VERSION, KUBECTL_VERSION};
use skopos_core::tools::{ToolName, ToolSource, ToolsConfig};
use tokio_util::sync::CancellationToken;

const RUN_LIMIT: Duration = Duration::from_secs(60);

fn capture() -> Output {
    Output::Capture {
        stdout_limit: 1 << 20,
        stderr_limit: 1 << 20,
    }
}

async fn stdout(program: &str, args: &[&str]) -> String {
    let spec = ProcessSpec::new(program, args.iter().copied(), RUN_LIMIT);
    let output = run(spec, capture(), CancellationToken::new())
        .await
        .unwrap();
    assert!(
        output.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

#[tokio::test]
#[ignore = "needs make test-kind, and the network on its first run"]
async fn the_pinned_helm_and_kubectl_download_and_run() {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let home = tempfile::tempdir().unwrap();
    let paths = AppPaths::under(&repo.join("e2e/.tmp/tools"), home.path());
    let core = AppCore::start_with_kubeconfig_env(paths, None)
        .await
        .unwrap();
    // CI runners have helm and kubectl on PATH; only the managed copies count here.
    core.set_tools_config_for_test(ToolsConfig {
        search_path: Some(OsString::new()),
        ..ToolsConfig::default()
    });

    let helm = core.tools_download(ToolName::Helm).await.unwrap();
    assert_eq!(helm.source, ToolSource::Managed);
    assert_eq!(helm.version.as_deref(), Some(HELM_VERSION));
    let kubectl = core.tools_download(ToolName::Kubectl).await.unwrap();
    assert_eq!(kubectl.source, ToolSource::Managed);
    assert_eq!(kubectl.version.as_deref(), Some(KUBECTL_VERSION));

    // A second call finds the copy in place and leaves it alone.
    let helm_path = helm.path.clone().unwrap();
    let modified = std::fs::metadata(&helm_path).unwrap().modified().unwrap();
    assert_eq!(core.tools_download(ToolName::Helm).await.unwrap(), helm);
    assert_eq!(
        std::fs::metadata(&helm_path).unwrap().modified().unwrap(),
        modified
    );

    let version = stdout(&helm_path, &["version", "--template", "{{.Version}}"]).await;
    assert_eq!(version, HELM_VERSION);
    let kubeconfig = repo.join("e2e/.tmp/kubeconfig");
    let kubeconfig = kubeconfig.to_str().unwrap();
    let namespace = stdout(
        kubectl.path.as_deref().unwrap(),
        &[
            "--kubeconfig",
            kubeconfig,
            "get",
            "namespace",
            "kube-system",
            "-o",
            "name",
        ],
    )
    .await;
    assert_eq!(namespace.trim(), "namespace/kube-system");
    core.shutdown().await;
}
