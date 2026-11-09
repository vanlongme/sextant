//! Helm against a fake `helm`, a shell script that records its arguments. Real helm runs in
//! `kind_helm.rs`. The scripts need a Unix shell, so this file runs on Unix.
#![cfg(unix)]

mod support;

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use skopos_core::app_core::AppCore;
use skopos_core::error::ErrorCode;
use skopos_core::helm::{
    ChartRef, HelmHomes, HelmInstallRequest, HelmRepo, HelmRepoAdd, HelmUpgradeRequest,
    RepoProblem, RepoProblemKind,
};
use skopos_core::kubeconfig::ClusterId;
use skopos_core::paths::AppPaths;
use skopos_core::sessions::{SessionEvent, SessionOutput};
use skopos_core::tools::{ToolSource, ToolsConfig};
use skopos_fakekube::FakeKubeConfig;
use support::connected_fake;
use tempfile::TempDir;
use tokio::sync::mpsc;

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

/// Answers `helm env` with folders inside the fake's own root.
const ENV_BODY: &str = r#"d=$(cd "$(dirname "$0")/.." && pwd)
if [ "$1" = env ]; then
  printf 'HELM_BIN="helm"\nHELM_REPOSITORY_CACHE="%s"\nHELM_REPOSITORY_CONFIG="%s"\n' "$d/cache" "$d/repositories.yaml"
fi"#;

/// What `helm repo index` wrote for the fixture chart, trimmed.
const FIXTURE_INDEX: &str = "apiVersion: v1
entries:
  skopos-fixture:
  - appVersion: 1.1.0
    created: \"2026-11-09T09:20:00.1+07:00\"
    description: A small chart for the SkoposIDE Helm tests
    keywords:
    - test
    - fixture
    name: skopos-fixture
    version: 0.2.0
  - appVersion: 1.0.0
    description: A small chart for the SkoposIDE Helm tests
    name: skopos-fixture
    version: 0.1.0
";

/// Three repos: `fixture` with an index, `broken` with an index that does not parse, and
/// `gone` with none.
fn write_repos(helm: &FakeHelm) {
    let cache = helm.path().join("cache");
    std::fs::create_dir_all(&cache).unwrap();
    std::fs::write(
        helm.path().join("repositories.yaml"),
        "apiVersion: \"\"\nrepositories:\n- name: fixture\n  url: http://127.0.0.1:1\n  password: s3cret\n- name: broken\n  url: http://127.0.0.1:2\n- name: gone\n  url: http://127.0.0.1:3\n",
    )
    .unwrap();
    std::fs::write(cache.join("fixture-index.yaml"), FIXTURE_INDEX).unwrap();
    std::fs::write(cache.join("broken-index.yaml"), "entries: [").unwrap();
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

#[tokio::test]
async fn repos_are_listed_by_helm_with_the_test_homes() {
    let helm = FakeHelm::new(
        "v4.3.1",
        r#"printf '%s' "$HELM_CONFIG_HOME" > "$(dirname "$0")/../config-home"
printf '[{"name":"fixture","url":"http://127.0.0.1:1"}]'"#,
    );
    let core = helm.core().await;
    let repos = core.helm_repo_list().await.unwrap();
    assert_eq!(
        repos,
        [HelmRepo {
            name: "fixture".into(),
            url: "http://127.0.0.1:1".into()
        }]
    );
    assert_eq!(helm.calls(), [strings(&["repo", "list", "--output=json"])]);
    let config_home = std::fs::read_to_string(helm.path().join("config-home")).unwrap();
    assert_eq!(Path::new(&config_home), helm.path().join("helm/config"));
    core.shutdown().await;
}

#[tokio::test]
async fn a_repo_password_goes_on_stdin_and_never_in_the_arguments() {
    let helm = FakeHelm::new("v4.3.1", r#"cat > "$(dirname "$0")/../stdin""#);
    let core = helm.core().await;
    core.helm_repo_add(HelmRepoAdd {
        name: "fixture".into(),
        url: "http://127.0.0.1:1".into(),
        username: Some("u".into()),
        password: Some("s3cret".into()),
    })
    .await
    .unwrap();
    assert_eq!(
        helm.calls(),
        [strings(&[
            "repo",
            "add",
            "fixture",
            "http://127.0.0.1:1",
            "--username=u",
            "--password-stdin",
        ])]
    );
    let stdin = std::fs::read_to_string(helm.path().join("stdin")).unwrap();
    assert_eq!(stdin, "s3cret");
    core.shutdown().await;
}

#[tokio::test]
async fn a_repo_without_credentials_reads_no_stdin() {
    let helm = FakeHelm::new("v4.3.1", "exit 0");
    let core = helm.core().await;
    let add = |username: Option<&str>, password: Option<&str>| HelmRepoAdd {
        name: "fixture".into(),
        url: "http://127.0.0.1:1".into(),
        username: username.map(Into::into),
        password: password.map(Into::into),
    };
    core.helm_repo_add(add(Some(""), Some(""))).await.unwrap();
    assert_eq!(
        helm.calls(),
        [strings(&["repo", "add", "fixture", "http://127.0.0.1:1"])]
    );
    for (username, password) in [(Some("u"), None), (None, Some("p")), (Some("u"), Some(""))] {
        let error = core
            .helm_repo_add(add(username, password))
            .await
            .unwrap_err();
        assert_eq!(
            error.code,
            ErrorCode::InvalidInput,
            "{username:?} {password:?}"
        );
    }
    assert_eq!(helm.calls().len(), 1);
    core.shutdown().await;
}

#[tokio::test]
async fn adding_a_repo_that_exists_is_a_conflict() {
    let helm = FakeHelm::new(
        "v4.3.1",
        r#"echo '"fixture" already exists with the same configuration, skipping'"#,
    );
    let core = helm.core().await;
    let error = core
        .helm_repo_add(HelmRepoAdd {
            name: "fixture".into(),
            url: "http://127.0.0.1:1".into(),
            username: None,
            password: None,
        })
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict);
    core.shutdown().await;
}

#[tokio::test]
async fn removing_a_missing_repo_is_not_found() {
    let helm = FakeHelm::new(
        "v4.3.1",
        r#"echo 'Error: no repo named "missing" found' >&2; exit 1"#,
    );
    let core = helm.core().await;
    let error = core.helm_repo_remove("missing").await.unwrap_err();
    assert_eq!(error.code, ErrorCode::NotFound);
    assert_eq!(error.message, r#"no repo named "missing" found"#);
    assert_eq!(helm.calls(), [strings(&["repo", "remove", "missing"])]);
    core.shutdown().await;
}

#[tokio::test]
async fn updating_with_no_repos_is_done() {
    let helm = FakeHelm::new(
        "v4.3.1",
        "echo 'Error: no repositories found. You must add one before updating' >&2; exit 1",
    );
    let core = helm.core().await;
    core.helm_repo_update(None).await.unwrap();
    core.helm_repo_update(Some(Vec::new())).await.unwrap();
    assert_eq!(helm.calls(), [strings(&["repo", "update"])]);
    let error = core
        .helm_repo_update(Some(vec!["fixture".into()]))
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Internal);
    assert_eq!(helm.calls()[1], strings(&["repo", "update", "fixture"]));
    let error = core
        .helm_repo_update(Some(vec!["-x".into()]))
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
    core.shutdown().await;
}

#[tokio::test]
async fn updating_an_unreachable_repo_fails_even_when_helm_exits_zero() {
    let helm = FakeHelm::new(
        "v3.22.1",
        r#"echo 'Hang tight'; echo '...Unable to get an update from the "dead" chart repository (http://127.0.0.1:9):'; echo '	connection refused'; echo 'Update Complete.'"#,
    );
    let core = helm.core().await;
    let error = core
        .helm_repo_update(Some(vec!["dead".into()]))
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Unreachable, "{error:?}");
    assert!(error.message.contains("dead"), "{error:?}");
    assert!(
        error
            .details
            .as_deref()
            .unwrap_or("")
            .contains("connection refused"),
        "{error:?}"
    );
    core.shutdown().await;
}

#[tokio::test]
async fn search_reads_the_cached_indexes_and_reports_repo_problems() {
    let helm = FakeHelm::new("v4.3.1", ENV_BODY);
    write_repos(&helm);
    let core = helm.core().await;

    let found = core.helm_chart_search("", None).await.unwrap();
    let names: Vec<String> = found
        .charts
        .iter()
        .map(|chart| format!("{}/{}", chart.repo, chart.name))
        .collect();
    assert_eq!(names, ["fixture/skopos-fixture"]);
    assert_eq!(found.charts[0].latest.version, "0.2.0");
    assert_eq!(found.charts[0].keywords, ["test", "fixture"]);
    assert_eq!(
        found.repo_problems,
        [
            RepoProblem {
                repo: "broken".into(),
                problem: RepoProblemKind::IndexInvalid
            },
            RepoProblem {
                repo: "gone".into(),
                problem: RepoProblemKind::IndexMissing
            },
        ]
    );

    // A changed index is read again. helm itself is asked once, for its folders.
    let cache = helm.path().join("cache");
    let newer = FIXTURE_INDEX.replace("0.2.0", "0.10.0");
    std::fs::write(cache.join("fixture-index.yaml"), newer).unwrap();
    let found = core.helm_chart_search("SKOPOS", Some(5)).await.unwrap();
    assert_eq!(found.charts[0].latest.version, "0.10.0");
    assert_eq!(helm.calls(), [strings(&["env"])]);
    core.shutdown().await;
}

#[tokio::test]
async fn chart_versions_come_newest_first() {
    let helm = FakeHelm::new("v4.3.1", ENV_BODY);
    write_repos(&helm);
    let core = helm.core().await;
    let versions = core
        .helm_chart_versions("fixture", "skopos-fixture")
        .await
        .unwrap();
    let texts: Vec<&str> = versions.iter().map(|v| v.version.as_str()).collect();
    assert_eq!(texts, ["0.2.0", "0.1.0"]);
    assert_eq!(versions[0].app_version.as_deref(), Some("1.1.0"));
    for (repo, chart, code) in [
        ("fixture", "nochart", ErrorCode::NotFound),
        ("gone", "skopos-fixture", ErrorCode::NotFound),
        ("broken", "skopos-fixture", ErrorCode::Internal),
        ("fixture", "-x", ErrorCode::InvalidInput),
    ] {
        let error = core.helm_chart_versions(repo, chart).await.unwrap_err();
        assert_eq!(error.code, code, "{repo}/{chart}");
    }
    core.shutdown().await;
}

#[tokio::test]
async fn readme_and_values_ask_helm_for_that_version() {
    let helm = FakeHelm::new("v4.3.1", r#"printf '# %s' "$2""#);
    let core = helm.core().await;
    let readme = core
        .helm_chart_readme("fixture", "skopos-fixture", "0.2.0")
        .await
        .unwrap();
    assert_eq!(readme, "# readme");
    let values = core
        .helm_chart_values("fixture", "skopos-fixture", "-0.1.0")
        .await
        .unwrap();
    assert_eq!(values, "# values");
    assert_eq!(
        helm.calls(),
        [
            strings(&[
                "show",
                "readme",
                "fixture/skopos-fixture",
                "--version=0.2.0"
            ]),
            strings(&[
                "show",
                "values",
                "fixture/skopos-fixture",
                "--version=-0.1.0"
            ]),
        ]
    );
    let error = core
        .helm_chart_readme("fixture", "skopos-fixture", " ")
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
    core.shutdown().await;
}

/// The `--kubeconfig=` argument helm gets for `id`.
fn kubeconfig_arg(core: &AppCore, id: &ClusterId) -> String {
    let path = core.cluster_kubeconfig_path(id).unwrap();
    format!("--kubeconfig={}", path.display())
}

const LIST: &str = r#"[{"name":"web","namespace":"skopos-test-helm","revision":"2","updated":"2026-11-09 09:25:49.373528822 +0700 +07","status":"deployed","chart":"skopos-fixture-0.2.0","app_version":"1.1.0"},{"name":"api","namespace":"default","revision":"1","updated":"2026-11-09 09:20:00 +0700 +07","status":"failed","chart":"skopos-fixture-0.1.0","app_version":"1.0.0"}]"#;

const FORBIDDEN: &str = r#"echo 'Error: list: failed to list: secrets is forbidden: User "viewer" cannot list resource "secrets" in API group ""' >&2; exit 1"#;

#[tokio::test]
async fn releases_are_listed_with_the_cluster_kubeconfig() {
    let helm = FakeHelm::new("v4.3.1", &format!("printf '%s' '{LIST}'"));
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    helm.configure(&core);
    let list = core.helm_release_list(&id, None).await.unwrap();
    let names: Vec<(&str, &str)> = list
        .releases
        .iter()
        .map(|r| (r.namespace.as_str(), r.name.as_str()))
        .collect();
    assert_eq!(names, [("default", "api"), ("skopos-test-helm", "web")]);
    assert!(!list.partial);
    assert!(list.failed_namespaces.is_empty());
    assert_eq!(
        list.releases[1].updated.as_deref(),
        Some("2026-11-09T09:25:49.373528822+07:00")
    );
    let kubeconfig = kubeconfig_arg(&core, &id);
    let expected = strings(&[
        "list",
        kubeconfig.as_str(),
        "--all-namespaces",
        "--deployed",
        "--failed",
        "--pending",
        "--superseded",
        "--uninstalled",
        "--uninstalling",
        "--max=0",
        "--output=json",
    ]);
    assert_eq!(helm.calls(), [expected]);
    core.shutdown().await;
}

#[tokio::test]
async fn a_forbidden_list_of_every_namespace_lists_each_namespace() {
    let body = format!(
        "case \"$*\" in *--all-namespaces*|*--namespace=kube-system*) {FORBIDDEN};; esac\n\
         printf '%s' '[{{\"name\":\"web\",\"namespace\":\"default\",\"revision\":\"2\",\"status\":\"deployed\",\"chart\":\"skopos-fixture-0.2.0\"}}]'"
    );
    let helm = FakeHelm::new("v4.3.1", &body);
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    helm.configure(&core);
    let list = core.helm_release_list(&id, None).await.unwrap();
    assert_eq!(list.releases.len(), 1);
    assert_eq!(list.releases[0].namespace, "default");
    assert!(list.partial);
    assert_eq!(list.failed_namespaces, ["kube-system"]);
    let mut namespaces: Vec<String> = helm
        .calls()
        .iter()
        .flat_map(|call| {
            call.iter()
                .filter(|arg| arg.starts_with("--namespace="))
                .cloned()
        })
        .collect();
    namespaces.sort();
    assert_eq!(
        namespaces,
        ["--namespace=default", "--namespace=kube-system"]
    );
    core.shutdown().await;
}

#[tokio::test]
async fn a_list_is_refused_when_every_namespace_fails() {
    let helm = FakeHelm::new("v4.3.1", FORBIDDEN);
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    helm.configure(&core);
    let error = core.helm_release_list(&id, None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::Forbidden);
    assert!(error.message.contains("forbidden"), "{}", error.message);
    let error = core
        .helm_release_list(&id, Some(vec!["default".into()]))
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Forbidden);
    let calls = helm.calls().len();
    let empty = core.helm_release_list(&id, Some(Vec::new())).await.unwrap();
    assert!(empty.releases.is_empty() && !empty.partial);
    assert_eq!(helm.calls().len(), calls);
    let error = core
        .helm_release_list(&id, Some(vec!["Bad".into()]))
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
    core.shutdown().await;
}

const STATUS: &str = r#"{"name":"rel","info":{"first_deployed":"2026-11-09T09:25:49.373528822+07:00","last_deployed":"2026-11-09T09:30:12.1+07:00","description":"Upgrade complete","status":"deployed","notes":"Release rel holds hello."},"manifest":"---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: rel-config\n---\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: rel-web\n---\napiVersion: v1\nkind: Namespace\nmetadata:\n  name: rel-space\n---\napiVersion: example.test/v1\nkind: Widget\nmetadata:\n  name: gadget\n","version":2,"namespace":"skopos-test-helm"}"#;

const HISTORY: &str = r#"[{"revision":1,"updated":"2026-11-09T09:25:49.373528822+07:00","status":"superseded","chart":"skopos-fixture-0.1.0","app_version":"1.0.0","description":"Install complete"},{"revision":2,"updated":"2026-11-09T09:30:12.1+07:00","status":"deployed","chart":"skopos-fixture-0.2.0","app_version":"1.1.0","description":"Upgrade complete"}]"#;

#[tokio::test]
async fn a_release_detail_comes_from_status_history_and_discovery() {
    let body = format!(
        "case \"$1\" in status) printf '%s' '{STATUS}';; history) printf '%s' '{HISTORY}';; esac"
    );
    let helm = FakeHelm::new("v4.3.1", &body);
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    helm.configure(&core);
    let detail = core
        .helm_release_get(&id, "skopos-test-helm", "rel")
        .await
        .unwrap();
    assert_eq!(detail.release.chart, "skopos-fixture-0.2.0");
    assert_eq!(detail.release.app_version.as_deref(), Some("1.1.0"));
    let resources: Vec<(String, Option<String>, Option<String>)> = detail
        .resources
        .iter()
        .map(|r| {
            (
                r.name.clone(),
                r.namespace.clone(),
                r.resource.as_ref().map(|served| served.plural.clone()),
            )
        })
        .collect();
    assert_eq!(
        resources,
        [
            (
                "rel-config".into(),
                Some("skopos-test-helm".into()),
                Some("configmaps".into())
            ),
            (
                "rel-web".into(),
                Some("skopos-test-helm".into()),
                Some("deployments".into())
            ),
            ("rel-space".into(), None, Some("namespaces".into())),
            ("gadget".into(), None, None),
        ]
    );
    let kubeconfig = kubeconfig_arg(&core, &id);
    let kubeconfig = kubeconfig.as_str();
    let mut calls = helm.calls();
    calls.sort();
    assert_eq!(
        calls,
        [
            strings(&[
                "history",
                "rel",
                kubeconfig,
                "--namespace=skopos-test-helm",
                "--max=10000",
                "--output=json"
            ]),
            strings(&[
                "status",
                "rel",
                kubeconfig,
                "--namespace=skopos-test-helm",
                "--output=json"
            ]),
        ]
    );
    let history = core
        .helm_release_history(&id, "skopos-test-helm", "rel")
        .await
        .unwrap();
    assert_eq!(
        history.iter().map(|r| r.revision).collect::<Vec<_>>(),
        [2, 1]
    );
    let error = core
        .helm_release_get(&id, "skopos-test-helm", "-rel")
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
    core.shutdown().await;
}

#[tokio::test]
async fn release_values_print_null_as_empty() {
    let helm = FakeHelm::new(
        "v4.3.1",
        r#"case "$*" in *--all*) printf 'message: hello\nreplicas: 0\n';; *) printf 'null\n';; esac"#,
    );
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    helm.configure(&core);
    let given = core
        .helm_release_values(&id, "skopos-test-helm", "rel", false)
        .await
        .unwrap();
    assert_eq!(given, "");
    let all = core
        .helm_release_values(&id, "skopos-test-helm", "rel", true)
        .await
        .unwrap();
    assert_eq!(all, "message: hello\nreplicas: 0\n");
    let kubeconfig = kubeconfig_arg(&core, &id);
    let kubeconfig = kubeconfig.as_str();
    assert_eq!(
        helm.calls(),
        [
            strings(&[
                "get",
                "values",
                "rel",
                kubeconfig,
                "--namespace=skopos-test-helm",
                "--output=yaml"
            ]),
            strings(&[
                "get",
                "values",
                "rel",
                kubeconfig,
                "--namespace=skopos-test-helm",
                "--all",
                "--output=yaml"
            ]),
        ]
    );
    core.shutdown().await;
}

#[tokio::test]
async fn release_commands_need_a_connected_cluster() {
    let helm = FakeHelm::new("v4.3.1", "exit 0");
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    helm.configure(&core);
    core.cluster_disconnect(&id).await.unwrap();
    let error = core.helm_release_list(&id, None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::Unreachable);
    assert!(helm.calls().is_empty());
    core.shutdown().await;
}

fn install_request() -> HelmInstallRequest {
    HelmInstallRequest {
        namespace: "skopos-test-helm".into(),
        release_name: Some("rel".into()),
        chart: ChartRef {
            repo: "fixture".into(),
            chart: "skopos-fixture".into(),
            version: "0.1.0".into(),
        },
        values: "message: hi\n".into(),
        create_namespace: true,
        wait: false,
    }
}

/// The helm values files left in a core's runtime folder.
fn values_files(root: &Path) -> Vec<PathBuf> {
    let runtime = root.join("app/data/runtime");
    std::fs::read_dir(runtime)
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

fn is_last(event: &SessionEvent) -> bool {
    matches!(
        event,
        SessionEvent::Exited { .. } | SessionEvent::Failed { .. }
    )
}

/// Everything a session sent until its last event: the text, and the events.
async fn session_output(mut output: mpsc::Receiver<SessionOutput>) -> (String, Vec<SessionEvent>) {
    let mut data = Vec::new();
    let mut events = Vec::new();
    let collect = async {
        while let Some(item) = output.recv().await {
            match item {
                SessionOutput::Data(bytes) => data.extend(bytes),
                SessionOutput::Event(event) => {
                    let last = is_last(&event);
                    events.push(event);
                    if last {
                        break;
                    }
                }
            }
        }
    };
    tokio::time::timeout(Duration::from_secs(30), collect)
        .await
        .expect("the session ended");
    (String::from_utf8_lossy(&data).into_owned(), events)
}

/// Copies the values file helm was given to `<fake root>/values-seen`.
const COPY_VALUES: &str = r#"for arg in "$@"; do
  case "$arg" in --values=*) cp "${arg#--values=}" "$(dirname "$0")/../values-seen";; esac
done"#;

#[tokio::test]
async fn an_install_streams_helms_output_and_exits_zero() {
    let body =
        format!("{COPY_VALUES}\necho 'NAME: rel'\necho 'a warning' >&2\necho 'STATUS: deployed'");
    let helm = FakeHelm::new("v4.3.1", &body);
    let (core, _fake, id, root) = connected_fake(FakeKubeConfig::default()).await;
    helm.configure(&core);
    let (tx, rx) = mpsc::channel(32);
    let session = core
        .helm_install_start(&id, &install_request(), tx)
        .await
        .unwrap();
    assert!(session.starts_with("session-"), "{session}");
    let (data, events) = session_output(rx).await;
    assert!(
        matches!(events[0], SessionEvent::Started { tty: false }),
        "{events:?}"
    );
    assert!(
        matches!(events.last(), Some(SessionEvent::Exited { code: Some(0) })),
        "{events:?}"
    );
    for text in ["NAME: rel\n", "a warning\n", "STATUS: deployed\n"] {
        assert!(data.contains(text), "{data}");
    }
    let seen = std::fs::read_to_string(helm.path().join("values-seen")).unwrap();
    assert_eq!(seen, "message: hi\n");
    let call = &helm.calls()[0];
    assert_eq!(call[..3], ["install", "rel", "fixture/skopos-fixture"]);
    assert_eq!(call[3], kubeconfig_arg(&core, &id));
    let runtime = root.path().join("app/data/runtime");
    let values_prefix = format!("--values={}", runtime.join("helm-values-").display());
    assert!(
        call.iter().any(|arg| arg.starts_with(&values_prefix)),
        "{call:?}"
    );
    assert!(call.contains(&"--create-namespace".to_owned()), "{call:?}");
    assert!(core.sessions_wait_idle(Duration::from_secs(5)).await);
    assert!(values_files(root.path()).is_empty());
    core.shutdown().await;
}

#[tokio::test]
async fn a_failed_action_reports_helms_last_error_line() {
    let helm = FakeHelm::new(
        "v4.3.1",
        r#"echo 'level=ERROR msg="release name check failed" error="cannot reuse a name that is still in use"' >&2
echo 'Error: INSTALLATION FAILED: release name check failed: cannot reuse a name that is still in use' >&2
exit 1"#,
    );
    let (core, _fake, id, root) = connected_fake(FakeKubeConfig::default()).await;
    helm.configure(&core);
    let (tx, rx) = mpsc::channel(32);
    core.helm_install_start(&id, &install_request(), tx)
        .await
        .unwrap();
    let (data, events) = session_output(rx).await;
    assert!(data.contains("level=ERROR"), "{data}");
    let Some(SessionEvent::Failed { error, .. }) = events.last() else {
        panic!("{events:?}");
    };
    assert_eq!(error.code, ErrorCode::Conflict);
    assert_eq!(
        error.message,
        "INSTALLATION FAILED: release name check failed: cannot reuse a name that is still in use"
    );
    assert!(error.details.as_deref().unwrap().contains("level=ERROR"));
    assert!(core.sessions_wait_idle(Duration::from_secs(5)).await);
    assert!(values_files(root.path()).is_empty());
    core.shutdown().await;
}

#[tokio::test]
async fn stopping_an_action_ends_it_as_cancelled_and_deletes_the_values_file() {
    let helm = FakeHelm::new("v4.3.1", "echo waiting\nexec sleep 30");
    let (core, _fake, id, root) = connected_fake(FakeKubeConfig::default()).await;
    helm.configure(&core);
    let mut request = install_request();
    request.wait = true;
    let (tx, mut rx) = mpsc::channel(32);
    let session = core.helm_install_start(&id, &request, tx).await.unwrap();
    loop {
        let item = tokio::time::timeout(Duration::from_secs(30), rx.recv())
            .await
            .expect("helm printed something");
        match item {
            Some(SessionOutput::Data(bytes))
                if String::from_utf8_lossy(&bytes).contains("waiting") =>
            {
                break
            }
            Some(_) => {}
            None => panic!("the session ended early"),
        }
    }
    assert_eq!(values_files(root.path()).len(), 1);
    let stopped = Instant::now();
    core.session_stop(&session);
    let (_, events) = session_output(rx).await;
    let Some(SessionEvent::Failed { error, .. }) = events.last() else {
        panic!("{events:?}");
    };
    assert_eq!(error.code, ErrorCode::Cancelled);
    assert!(stopped.elapsed() < Duration::from_secs(10));
    assert!(core.sessions_wait_idle(Duration::from_secs(5)).await);
    assert!(values_files(root.path()).is_empty());
    core.shutdown().await;
}

#[tokio::test]
async fn bad_requests_are_refused_before_helm_runs() {
    let helm = FakeHelm::new("v4.3.1", "exit 0");
    let (core, _fake, id, root) = connected_fake(FakeKubeConfig::default()).await;
    helm.configure(&core);
    let mut bad_values = install_request();
    bad_values.values = "a: [\n".into();
    let mut bad_name = install_request();
    bad_name.release_name = Some("Bad_Name".into());
    let mut no_version = install_request();
    no_version.chart.version = String::new();
    for request in [&bad_values, &bad_name, &no_version] {
        let (tx, _rx) = mpsc::channel(32);
        let error = core.helm_install_start(&id, request, tx).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput, "{request:?}");
        let error = core.helm_install_preview(&id, request).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput, "{request:?}");
    }
    let (tx, _rx) = mpsc::channel(32);
    let error = core
        .helm_rollback_start(&id, "skopos-test-helm", "rel", 0, false, tx)
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
    let (tx, _rx) = mpsc::channel(32);
    let error = core
        .helm_uninstall_start(&id, "skopos-test-helm", "-rel", false, tx)
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
    assert!(helm.calls().is_empty());
    assert_eq!(core.session_count(), 0);
    assert!(values_files(root.path()).is_empty());
    core.shutdown().await;
}

#[tokio::test]
async fn a_preview_returns_the_dry_run_and_starts_no_session() {
    let preview = r#"{"name":"rel","info":{"status":"pending-install","notes":"Release rel holds hi."},"manifest":"---\nkind: ConfigMap\n"}"#;
    let helm = FakeHelm::new("v4.3.1", &format!("printf '%s' '{preview}'"));
    let (core, _fake, id, root) = connected_fake(FakeKubeConfig::default()).await;
    helm.configure(&core);
    let mut request = install_request();
    request.wait = true;
    let found = core.helm_install_preview(&id, &request).await.unwrap();
    assert_eq!(found.release_name, "rel");
    assert_eq!(found.manifest, "---\nkind: ConfigMap\n");
    assert_eq!(found.notes.as_deref(), Some("Release rel holds hi."));
    let call = &helm.calls()[0];
    assert!(
        call.ends_with(&strings(&["--dry-run=server", "--output=json"])),
        "{call:?}"
    );
    assert!(
        !call.iter().any(|arg| arg.starts_with("--wait")),
        "{call:?}"
    );
    assert_eq!(core.session_count(), 0);
    assert!(values_files(root.path()).is_empty());
    core.shutdown().await;
}

#[tokio::test]
async fn an_upgrade_sends_the_whole_values_set() {
    let helm = FakeHelm::new("v3.22.1", COPY_VALUES);
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    helm.configure(&core);
    let request = HelmUpgradeRequest {
        namespace: "skopos-test-helm".into(),
        release: "rel".into(),
        chart: ChartRef {
            repo: "fixture".into(),
            chart: "skopos-fixture".into(),
            version: "0.2.0".into(),
        },
        values: String::new(),
        wait: true,
    };
    let (tx, rx) = mpsc::channel(32);
    core.helm_upgrade_start(&id, &request, tx).await.unwrap();
    let (_, events) = session_output(rx).await;
    assert!(
        matches!(events.last(), Some(SessionEvent::Exited { code: Some(0) })),
        "{events:?}"
    );
    let seen = std::fs::read_to_string(helm.path().join("values-seen")).unwrap();
    assert_eq!(seen, "");
    let call = &helm.calls()[0];
    assert_eq!(call[..3], ["upgrade", "rel", "fixture/skopos-fixture"]);
    assert!(
        call.ends_with(&strings(&["--reset-values", "--wait"])),
        "{call:?}"
    );
    core.shutdown().await;
}

#[tokio::test]
async fn rollback_and_uninstall_run_as_sessions() {
    let helm = FakeHelm::new("v4.3.1", "echo 'Happy Helming!'");
    let (core, _fake, id, _root) = connected_fake(FakeKubeConfig::default()).await;
    helm.configure(&core);
    let (tx, rx) = mpsc::channel(32);
    core.helm_rollback_start(&id, "skopos-test-helm", "rel", 1, true, tx)
        .await
        .unwrap();
    let (data, events) = session_output(rx).await;
    assert!(data.contains("Happy Helming!"), "{data}");
    assert!(
        matches!(events.last(), Some(SessionEvent::Exited { code: Some(0) })),
        "{events:?}"
    );
    let (tx, rx) = mpsc::channel(32);
    core.helm_uninstall_start(&id, "skopos-test-helm", "rel", false, tx)
        .await
        .unwrap();
    let (_, events) = session_output(rx).await;
    assert!(
        matches!(events.last(), Some(SessionEvent::Exited { code: Some(0) })),
        "{events:?}"
    );
    let kubeconfig = kubeconfig_arg(&core, &id);
    let kubeconfig = kubeconfig.as_str();
    assert_eq!(
        helm.calls(),
        [
            strings(&[
                "rollback",
                "rel",
                "1",
                kubeconfig,
                "--namespace=skopos-test-helm",
                "--wait=watcher"
            ]),
            strings(&[
                "uninstall",
                "rel",
                kubeconfig,
                "--namespace=skopos-test-helm"
            ]),
        ]
    );
    core.shutdown().await;
}
