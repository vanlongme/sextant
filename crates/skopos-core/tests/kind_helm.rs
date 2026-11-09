//! Helm (F15) against the real `skopos-e2e` kind cluster. Each case runs with helm 4.3.1, the
//! managed copy in `e2e/.tmp/tools`, and with helm 3.22.1, which this test downloads into
//! `e2e/.tmp/tools-helm3`. The test serves the fixture chart itself. The first run needs the
//! network; later runs are offline. Run with `make test-kind`.
//! Linux only: the stop case reads `/proc`, and helm 3.22.1 is pinned here for Linux alone.
#![cfg(target_os = "linux")]

mod support;

use std::ffi::OsString;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::routing::get;
use axum::Router;
use futures::FutureExt;
use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::authentication::v1::TokenRequest;
use k8s_openapi::api::core::v1::{ConfigMap, Namespace, ServiceAccount};
use k8s_openapi::api::rbac::v1::{Role, RoleBinding};
use kube::api::{DeleteParams, PostParams};
use kube::{Api, Client};
use serde_json::{json, Value};
use skopos_core::app_core::AppCore;
use skopos_core::error::ErrorCode;
use skopos_core::helm::{
    ChartRef, HelmHomes, HelmInstallRequest, HelmRepo, HelmRepoAdd, HelmUpgradeRequest,
    ManifestResource,
};
use skopos_core::kubeconfig::ClusterId;
use skopos_core::paths::AppPaths;
use skopos_core::process::{run, Output, ProcessSpec};
use skopos_core::resources::ResourceRef;
use skopos_core::sessions::{SessionEvent, SessionOutput};
use skopos_core::tools::pinned::{ArchiveFormat, PinnedDownload, HELM_VERSION};
use skopos_core::tools::{ToolName, ToolsConfig};
use support::{connected_kind, connected_with, in_namespace};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

const WAIT: Duration = Duration::from_secs(180);
const RUN_LIMIT: Duration = Duration::from_secs(60);
const RELEASE: &str = "rel";
const HELM_3: &str = "v3.22.1";
/// From `https://get.helm.sh/helm-v3.22.1-linux-<arch>.tar.gz.sha256sum`, copied on 2026-11-09.
const HELM_3_SHA256: [(&str, &str); 2] = [
    (
        "amd64",
        "896cf63684a42a723d61c980369d6e588330927deb13676ca0d85006dd6da0ea",
    ),
    (
        "arm64",
        "4c29e286b279d170fa048ddfc3e4e83dcd069ca9c52102766ba672d7149e694d",
    ),
];

#[derive(Debug, Clone, Copy)]
enum Version {
    /// The managed helm 4.
    Four,
    /// helm 3.22.1, which only these tests download.
    Three,
}

impl Version {
    fn major(self) -> u8 {
        match self {
            Version::Four => 4,
            Version::Three => 3,
        }
    }

    fn tag(self) -> &'static str {
        match self {
            Version::Four => HELM_VERSION,
            Version::Three => HELM_3,
        }
    }

    fn namespace(self, case: &str) -> String {
        format!("skopos-test-helm{}{case}", self.major())
    }
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn helm_3_downloads() -> Vec<PinnedDownload> {
    HELM_3_SHA256
        .into_iter()
        .map(|(arch, sha256)| PinnedDownload {
            tool: ToolName::Helm,
            version: HELM_3.to_owned(),
            os: "linux".to_owned(),
            arch: arch.to_owned(),
            url: format!("https://get.helm.sh/helm-{HELM_3}-linux-{arch}.tar.gz"),
            sha256: sha256.to_owned(),
            format: ArchiveFormat::TarGz,
            entry: Some(format!("linux-{arch}/helm")),
        })
        .collect()
}

/// The helm binary for `version`, downloaded on the first run and reused after that.
async fn helm_path(version: Version) -> String {
    let (root, downloads) = match version {
        Version::Four => ("e2e/.tmp/tools", ToolsConfig::default().downloads),
        Version::Three => ("e2e/.tmp/tools-helm3", helm_3_downloads()),
    };
    let home = tempfile::tempdir().unwrap();
    let paths = AppPaths::under(&repo_root().join(root), home.path());
    let core = AppCore::start_with_kubeconfig_env(paths, None)
        .await
        .unwrap();
    // CI runners have helm on PATH; only the managed copy counts here.
    core.set_tools_config_for_test(ToolsConfig {
        downloads,
        search_path: Some(OsString::new()),
        ..ToolsConfig::default()
    });
    let status = core.tools_download(ToolName::Helm).await.unwrap();
    assert_eq!(status.version.as_deref(), Some(version.tag()));
    core.shutdown().await;
    status.path.unwrap()
}

/// Makes `core` run `helm`, with helm's folders inside `root`.
fn use_helm(core: &AppCore, helm: &str, root: &Path) {
    let folder = Path::new(helm).parent().unwrap();
    core.set_tools_config_for_test(ToolsConfig {
        search_path: Some(folder.as_os_str().to_owned()),
        ..ToolsConfig::default()
    });
    let homes = root.join("helm");
    core.set_helm_homes_for_test(HelmHomes {
        config: homes.join("config"),
        cache: homes.join("cache"),
        data: homes.join("data"),
    });
}

async fn run_helm(helm: &str, args: &[&str]) {
    let spec = ProcessSpec::new(helm, args.iter().copied(), RUN_LIMIT);
    let capture = Output::Capture {
        stdout_limit: 1 << 20,
        stderr_limit: 1 << 20,
    };
    let output = run(spec, capture, CancellationToken::new()).await.unwrap();
    assert!(
        output.success(),
        "helm {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

/// Packages the fixture chart as 0.1.0 and 0.2.0 into `dir`, indexes it and serves it.
/// Returns the repository URL.
async fn serve_charts(helm: &str, dir: &Path) -> String {
    let chart = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/helm/skopos-fixture");
    let chart = chart.to_str().unwrap();
    let folder = dir.to_str().unwrap();
    for (version, app_version) in [("0.1.0", "1.0.0"), ("0.2.0", "1.1.0")] {
        let args = [
            "package",
            chart,
            "--version",
            version,
            "--app-version",
            app_version,
            "--destination",
            folder,
        ];
        run_helm(helm, &args).await;
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    run_helm(helm, &["repo", "index", folder, "--url", &url]).await;
    let mut router = Router::new();
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        let body = Bytes::from(std::fs::read(&path).unwrap());
        router = router.route(&format!("/{name}"), get(move || async move { body }));
    }
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    url
}

fn fixture_repo(url: &str) -> HelmRepoAdd {
    HelmRepoAdd {
        name: "fixture".into(),
        url: url.into(),
        username: None,
        password: None,
    }
}

fn chart(version: &str) -> ChartRef {
    ChartRef {
        repo: "fixture".into(),
        chart: "skopos-fixture".into(),
        version: version.into(),
    }
}

fn install_request(namespace: &str) -> HelmInstallRequest {
    HelmInstallRequest {
        namespace: namespace.into(),
        release_name: Some(RELEASE.into()),
        chart: chart("0.1.0"),
        values: "message: hi\n".into(),
        create_namespace: true,
        wait: true,
    }
}

/// Everything a session sent until its last event, and that event.
async fn session_output(mut output: mpsc::Receiver<SessionOutput>) -> (String, SessionEvent) {
    let mut data = Vec::new();
    let collect = async {
        loop {
            match output
                .recv()
                .await
                .expect("the session sent its last event")
            {
                SessionOutput::Data(bytes) => data.extend(bytes),
                SessionOutput::Event(
                    last @ (SessionEvent::Exited { .. } | SessionEvent::Failed { .. }),
                ) => break last,
                SessionOutput::Event(_) => {}
            }
        }
    };
    let last = tokio::time::timeout(WAIT, collect)
        .await
        .expect("the session ended");
    (String::from_utf8_lossy(&data).into_owned(), last)
}

/// The session's output, once it exited with code 0.
async fn exited(output: mpsc::Receiver<SessionOutput>) -> String {
    let (text, last) = session_output(output).await;
    assert!(
        matches!(last, SessionEvent::Exited { code: Some(0) }),
        "{last:?}\n{text}"
    );
    text
}

/// The `message` in the release's ConfigMap, or `None` when there is no ConfigMap.
async fn config_message(client: &Client, namespace: &str) -> Option<String> {
    let maps: Api<ConfigMap> = Api::namespaced(client.clone(), namespace);
    let map = maps.get_opt("rel-config").await.unwrap()?;
    map.data?.get("message").cloned()
}

/// Runs `test` with no namespace `name` at its start, and deletes that namespace afterwards,
/// whether or not the test failed. The install creates the namespace.
async fn with_cleanup<Fut: Future<Output = ()>>(client: &Client, name: &str, test: Fut) {
    let namespaces: Api<Namespace> = Api::all(client.clone());
    let _ = namespaces.delete(name, &DeleteParams::default()).await;
    let started = Instant::now();
    while namespaces.get_opt(name).await.unwrap().is_some() {
        assert!(started.elapsed() < WAIT, "{name} is still there");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let result = AssertUnwindSafe(test).catch_unwind().await;
    let _ = namespaces.delete(name, &DeleteParams::default()).await;
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}

/// The helm values files left in a core's runtime folder.
fn values_files(root: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(root.join("app/data/runtime"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("helm-values-")
        })
        .collect()
}

/// The command lines of the helm processes still running in `namespace`.
fn helm_processes(namespace: &str) -> Vec<String> {
    let flag = format!("--namespace={namespace}");
    let mut found = Vec::new();
    for entry in std::fs::read_dir("/proc").unwrap().flatten() {
        let Ok(cmdline) = std::fs::read(entry.path().join("cmdline")) else {
            continue;
        };
        let args: Vec<String> = cmdline
            .split(|byte| *byte == 0)
            .map(|arg| String::from_utf8_lossy(arg).into_owned())
            .collect();
        if args[0].ends_with("/helm") && args.contains(&flag) {
            found.push(args.join(" "));
        }
    }
    found
}

fn from_json<T: serde::de::DeserializeOwned>(value: Value) -> T {
    serde_json::from_value(value).unwrap()
}

fn kubeconfig_with_token(token: &str) -> String {
    let path = repo_root().join("e2e/.tmp/kubeconfig");
    let source: Value = serde_yaml_ng::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let cluster = &source["clusters"][0]["cluster"];
    let config = json!({
        "apiVersion": "v1",
        "kind": "Config",
        "clusters": [{ "name": "viewer", "cluster": {
            "server": cluster["server"],
            "certificate-authority-data": cluster["certificate-authority-data"],
        } }],
        "users": [{ "name": "viewer", "user": { "token": token } }],
        "contexts": [{ "name": "viewer", "context": { "cluster": "viewer", "user": "viewer" } }],
        "current-context": "viewer",
    });
    serde_yaml_ng::to_string(&config).unwrap()
}

/// A token for a `viewer` service account that may only read ConfigMaps in `namespace`.
async fn viewer_token(client: &Client, namespace: &str) -> String {
    let made = PostParams::default();
    let accounts: Api<ServiceAccount> = Api::namespaced(client.clone(), namespace);
    accounts
        .create(
            &made,
            &from_json(json!({ "metadata": { "name": "viewer" } })),
        )
        .await
        .unwrap();
    let roles: Api<Role> = Api::namespaced(client.clone(), namespace);
    let role = json!({
        "metadata": { "name": "viewer" },
        "rules": [{ "apiGroups": [""], "resources": ["configmaps"], "verbs": ["get", "list", "watch"] }],
    });
    roles.create(&made, &from_json(role)).await.unwrap();
    let bindings: Api<RoleBinding> = Api::namespaced(client.clone(), namespace);
    let binding = json!({
        "metadata": { "name": "viewer" },
        "roleRef": { "apiGroup": "rbac.authorization.k8s.io", "kind": "Role", "name": "viewer" },
        "subjects": [{ "kind": "ServiceAccount", "name": "viewer", "namespace": namespace }],
    });
    bindings.create(&made, &from_json(binding)).await.unwrap();
    let request: TokenRequest = from_json(json!({
        "apiVersion": "authentication.k8s.io/v1",
        "kind": "TokenRequest",
        "spec": { "audiences": [] },
    }));
    accounts
        .create_token_request("viewer", &made, &request)
        .await
        .unwrap()
        .status
        .unwrap()
        .token
        .unwrap()
}

async fn repos(core: &AppCore, url: &str) {
    core.helm_repo_add(fixture_repo(url)).await.unwrap();
    assert_eq!(
        core.helm_repo_list().await.unwrap(),
        [HelmRepo {
            name: "fixture".into(),
            url: url.into(),
        }]
    );
    let error = core.helm_repo_add(fixture_repo(url)).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict, "{error:?}");
    let nowhere = HelmRepoAdd {
        name: "nowhere".into(),
        ..fixture_repo("http://127.0.0.1:9/")
    };
    let error = core.helm_repo_add(nowhere).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::Unreachable, "{error:?}");
    core.helm_repo_update(Some(vec!["fixture".into()]))
        .await
        .unwrap();
    core.helm_repo_update(None).await.unwrap();
}

async fn charts(core: &AppCore) {
    let found = core.helm_chart_search("skopos", None).await.unwrap();
    assert!(found.repo_problems.is_empty(), "{:?}", found.repo_problems);
    assert_eq!(found.charts.len(), 1, "{:?}", found.charts);
    let summary = &found.charts[0];
    assert_eq!(
        (summary.repo.as_str(), summary.name.as_str()),
        ("fixture", "skopos-fixture")
    );
    assert_eq!(summary.latest.version, "0.2.0");
    assert_eq!(summary.latest.app_version.as_deref(), Some("1.1.0"));
    assert_eq!(summary.keywords, ["test", "fixture"]);
    let none = core.helm_chart_search("no-such-chart", None).await.unwrap();
    assert!(none.charts.is_empty());
    let versions = core
        .helm_chart_versions("fixture", "skopos-fixture")
        .await
        .unwrap();
    let numbers: Vec<&str> = versions.iter().map(|v| v.version.as_str()).collect();
    assert_eq!(numbers, ["0.2.0", "0.1.0"]);
    assert!(versions[0].created.is_some());
    let readme = core
        .helm_chart_readme("fixture", "skopos-fixture", "0.1.0")
        .await
        .unwrap();
    assert!(readme.starts_with("# skopos-fixture"), "{readme}");
    let values = core
        .helm_chart_values("fixture", "skopos-fixture", "0.1.0")
        .await
        .unwrap();
    assert!(values.contains("message: hello"), "{values}");
    let error = core
        .helm_chart_readme("fixture", "skopos-fixture", "9.9.9")
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::NotFound, "{error:?}");
}

/// Preview, install, list, detail, values, upgrade, history, rollback and uninstall.
async fn release_lifecycle(core: &AppCore, id: &ClusterId, client: &Client, namespace: &str) {
    let install = install_request(namespace);
    let preview = core.helm_install_preview(id, &install).await.unwrap();
    assert_eq!(preview.release_name, RELEASE);
    assert!(
        preview.manifest.contains("name: rel-config"),
        "{}",
        preview.manifest
    );
    assert!(
        preview.manifest.contains("message: \"hi\""),
        "{}",
        preview.manifest
    );
    assert_eq!(
        preview.notes.as_deref().map(str::trim),
        Some("Release rel holds hi.")
    );
    let namespaces: Api<Namespace> = Api::all(client.clone());
    assert!(
        namespaces.get_opt(namespace).await.unwrap().is_none(),
        "the preview created the namespace"
    );

    let (tx, rx) = mpsc::channel(64);
    core.helm_install_start(id, &install, tx).await.unwrap();
    let text = exited(rx).await;
    assert!(text.contains("Release rel holds hi."), "{text}");
    assert_eq!(
        config_message(client, namespace).await.as_deref(),
        Some("hi")
    );

    let list = core.helm_release_list(id, None).await.unwrap();
    assert!(!list.partial);
    let release = list
        .releases
        .iter()
        .find(|r| r.namespace == namespace && r.name == RELEASE)
        .expect("the release is listed");
    assert_eq!((release.revision, release.status.as_str()), (1, "deployed"));
    assert_eq!(release.chart, "skopos-fixture-0.1.0");
    assert_eq!(release.chart_name.as_deref(), Some("skopos-fixture"));
    assert_eq!(release.chart_version.as_deref(), Some("0.1.0"));
    assert_eq!(release.app_version.as_deref(), Some("1.0.0"));
    let updated = release.updated.as_deref().unwrap();
    assert_eq!(updated.as_bytes()[10], b'T', "{updated}");
    let only = core
        .helm_release_list(id, Some(vec![namespace.to_owned()]))
        .await
        .unwrap();
    assert_eq!(only.releases.len(), 1);

    let detail = core.helm_release_get(id, namespace, RELEASE).await.unwrap();
    assert_eq!(detail.release.revision, 1);
    assert_eq!(detail.release.chart, "skopos-fixture-0.1.0");
    assert_eq!(detail.release.app_version.as_deref(), Some("1.0.0"));
    assert_eq!(detail.description.as_deref(), Some("Install complete"));
    assert_eq!(
        detail.notes.as_deref().map(str::trim),
        Some("Release rel holds hi.")
    );
    assert!(detail.first_deployed.is_some() && detail.last_deployed.is_some());
    assert_eq!(
        detail.resources,
        [ManifestResource {
            api_version: "v1".into(),
            kind: "ConfigMap".into(),
            namespace: Some(namespace.into()),
            name: "rel-config".into(),
            resource: Some(ResourceRef {
                group: String::new(),
                version: "v1".into(),
                plural: "configmaps".into(),
                kind: "ConfigMap".into(),
                namespaced: true,
            }),
        }]
    );
    let given = core
        .helm_release_values(id, namespace, RELEASE, false)
        .await
        .unwrap();
    assert_eq!(given, "message: hi\n");
    let all = core
        .helm_release_values(id, namespace, RELEASE, true)
        .await
        .unwrap();
    assert!(
        all.contains("message: hi") && all.contains("stuck: false"),
        "{all}"
    );

    // An emptied values editor: the release gets the chart's defaults back.
    let upgrade = HelmUpgradeRequest {
        namespace: namespace.into(),
        release: RELEASE.into(),
        chart: chart("0.2.0"),
        values: String::new(),
        wait: true,
    };
    let preview = core.helm_upgrade_preview(id, &upgrade).await.unwrap();
    assert!(
        preview.manifest.contains("message: \"hello\""),
        "{}",
        preview.manifest
    );
    assert_eq!(
        config_message(client, namespace).await.as_deref(),
        Some("hi")
    );
    let (tx, rx) = mpsc::channel(64);
    core.helm_upgrade_start(id, &upgrade, tx).await.unwrap();
    exited(rx).await;
    assert_eq!(
        config_message(client, namespace).await.as_deref(),
        Some("hello")
    );
    let given = core
        .helm_release_values(id, namespace, RELEASE, false)
        .await
        .unwrap();
    assert!(!given.contains("message"), "{given}");

    let history = core
        .helm_release_history(id, namespace, RELEASE)
        .await
        .unwrap();
    let revisions: Vec<(u32, &str, &str)> = history
        .iter()
        .map(|r| (r.revision, r.status.as_str(), r.chart.as_str()))
        .collect();
    assert_eq!(
        revisions,
        [
            (2, "deployed", "skopos-fixture-0.2.0"),
            (1, "superseded", "skopos-fixture-0.1.0"),
        ]
    );

    let (tx, rx) = mpsc::channel(64);
    core.helm_rollback_start(id, namespace, RELEASE, 1, true, tx)
        .await
        .unwrap();
    exited(rx).await;
    let detail = core.helm_release_get(id, namespace, RELEASE).await.unwrap();
    assert_eq!(
        (detail.release.revision, detail.release.chart.as_str()),
        (3, "skopos-fixture-0.1.0")
    );
    assert_eq!(
        config_message(client, namespace).await.as_deref(),
        Some("hi")
    );

    let (tx, rx) = mpsc::channel(64);
    core.helm_uninstall_start(id, namespace, RELEASE, true, tx)
        .await
        .unwrap();
    exited(rx).await;
    let after = core
        .helm_release_list(id, Some(vec![namespace.to_owned()]))
        .await
        .unwrap();
    assert!(after.releases.is_empty(), "{:?}", after.releases);
    assert_eq!(config_message(client, namespace).await, None);
}

async fn whole_flow(version: Version) {
    let helm = helm_path(version).await;
    let served = tempfile::tempdir().unwrap();
    let url = serve_charts(&helm, served.path()).await;
    let (core, id, root) = connected_kind().await;
    use_helm(&core, &helm, root.path());
    let info = core.helm_version().await.unwrap();
    assert_eq!(
        (info.version.as_str(), info.major),
        (version.tag(), version.major())
    );
    let client = core.cluster_client(&id).unwrap();
    let namespace = version.namespace("");
    with_cleanup(&client, &namespace, async {
        repos(&core, &url).await;
        charts(&core).await;
        release_lifecycle(&core, &id, &client, &namespace).await;
        core.helm_repo_remove("fixture").await.unwrap();
        assert!(core.helm_repo_list().await.unwrap().is_empty());
        let error = core.helm_repo_remove("fixture").await.unwrap_err();
        assert_eq!(error.code, ErrorCode::NotFound, "{error:?}");
    })
    .await;
    core.shutdown().await;
}

async fn viewer_install(version: Version) {
    let helm = helm_path(version).await;
    let served = tempfile::tempdir().unwrap();
    let url = serve_charts(&helm, served.path()).await;
    let (admin, admin_id, _admin_root) = connected_kind().await;
    let client = admin.cluster_client(&admin_id).unwrap();
    let namespace = version.namespace("-viewer");
    in_namespace(&client, &namespace, async {
        let token = viewer_token(&client, &namespace).await;
        let (core, id, root) = connected_with(&kubeconfig_with_token(&token), "viewer").await;
        use_helm(&core, &helm, root.path());
        core.helm_repo_add(fixture_repo(&url)).await.unwrap();
        let mut request = install_request(&namespace);
        request.create_namespace = false;
        request.wait = false;
        let (tx, rx) = mpsc::channel(64);
        core.helm_install_start(&id, &request, tx).await.unwrap();
        let (text, last) = session_output(rx).await;
        let SessionEvent::Failed { error, .. } = last else {
            panic!("{last:?}\n{text}");
        };
        assert_eq!(error.code, ErrorCode::Forbidden, "{error:?}");
        assert!(error.message.contains("forbidden"), "{}", error.message);
        let details = error.details.as_deref().unwrap_or_default();
        assert!(details.contains("forbidden"), "{details}");
        assert!(text.contains("forbidden"), "{text}");
        // Listing every namespace is forbidden, and so is each one the viewer can see.
        let error = core.helm_release_list(&id, None).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::Forbidden, "{error:?}");
        core.shutdown().await;
    })
    .await;
    admin.shutdown().await;
}

async fn stop_while_waiting(version: Version) {
    let helm = helm_path(version).await;
    let served = tempfile::tempdir().unwrap();
    let url = serve_charts(&helm, served.path()).await;
    let (core, id, root) = connected_kind().await;
    use_helm(&core, &helm, root.path());
    core.helm_repo_add(fixture_repo(&url)).await.unwrap();
    let client = core.cluster_client(&id).unwrap();
    let namespace = version.namespace("-stop");
    with_cleanup(&client, &namespace, async {
        let mut request = install_request(&namespace);
        request.values = "stuck: true\n".into();
        let (tx, rx) = mpsc::channel(64);
        let session = core.helm_install_start(&id, &request, tx).await.unwrap();
        // Once the Deployment exists, helm waits for a pod that never becomes ready.
        let deployments: Api<Deployment> = Api::namespaced(client.clone(), &namespace);
        let started = Instant::now();
        while deployments.get_opt("rel-stuck").await.unwrap().is_none() {
            assert!(started.elapsed() < WAIT, "helm created no Deployment");
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        assert_eq!(helm_processes(&namespace).len(), 1);
        assert_eq!(values_files(root.path()).len(), 1);
        let stopped = Instant::now();
        core.session_stop(&session);
        let (text, last) = session_output(rx).await;
        let SessionEvent::Failed { error, .. } = last else {
            panic!("{last:?}\n{text}");
        };
        assert_eq!(error.code, ErrorCode::Cancelled, "{error:?}");
        assert!(stopped.elapsed() < Duration::from_secs(10));
        let left = helm_processes(&namespace);
        assert!(left.is_empty(), "{left:?}");
        assert!(core.sessions_wait_idle(Duration::from_secs(5)).await);
        assert!(values_files(root.path()).is_empty());
        let list = core
            .helm_release_list(&id, Some(vec![namespace.clone()]))
            .await
            .unwrap();
        let status = list.releases.first().map(|r| r.status.as_str());
        assert!(
            matches!(status, Some("failed" | "pending-install")),
            "{status:?}"
        );
    })
    .await;
    core.shutdown().await;
}

#[tokio::test]
#[ignore = "needs make test-kind, and the network on its first run"]
async fn helm_4_runs_repos_charts_and_a_release_from_install_to_uninstall() {
    whole_flow(Version::Four).await;
}

#[tokio::test]
#[ignore = "needs make test-kind, and the network on its first run"]
async fn helm_3_runs_repos_charts_and_a_release_from_install_to_uninstall() {
    whole_flow(Version::Three).await;
}

#[tokio::test]
#[ignore = "needs make test-kind, and the network on its first run"]
async fn helm_4_install_by_a_viewer_is_forbidden() {
    viewer_install(Version::Four).await;
}

#[tokio::test]
#[ignore = "needs make test-kind, and the network on its first run"]
async fn helm_3_install_by_a_viewer_is_forbidden() {
    viewer_install(Version::Three).await;
}

#[tokio::test]
#[ignore = "needs make test-kind, and the network on its first run"]
async fn helm_4_stopping_a_waiting_install_leaves_no_helm_running() {
    stop_while_waiting(Version::Four).await;
}

#[tokio::test]
#[ignore = "needs make test-kind, and the network on its first run"]
async fn helm_3_stopping_a_waiting_install_leaves_no_helm_running() {
    stop_while_waiting(Version::Three).await;
}
