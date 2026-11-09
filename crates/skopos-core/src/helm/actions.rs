//! Install, upgrade, rollback and uninstall (F15). Each runs as a session that streams
//! helm's output; a preview runs a server-side dry run and returns what it rendered.

use std::ffi::OsString;
use std::fmt;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;
use ts_rs::TS;

use super::charts::{chart_name, check_version};
use super::{
    args, check_name, check_namespace, cluster_args, flag, helm_failure, parse_json, HelmBinary,
    HelmMajor,
};
use crate::app_core::AppCore;
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::kubeconfig::{with_location, ClusterId};
use crate::process::{self, Output, OutputLine, ProcessSpec, Stream};
use crate::resources::invalid;
use crate::sessions::{random_hex, SessionEvent, SessionOutput};

/// helm's own `--timeout`, 5 minutes per wait, ends most actions well before this.
const ACTION_LIMIT: Duration = Duration::from_secs(30 * 60);
/// What a session shows (spec §5.3). The rest is dropped after one note.
const OUTPUT_LIMIT: usize = 4 << 20;
const OUTPUT_NOTE: &[u8] = b"\n[more than 4 MiB of output: the rest is not shown]\n";
/// The end of stderr is kept for the error, because helm prints it last.
const STDERR_KEPT: usize = 1 << 20;
const LINE_BACKLOG: usize = 64;
const RELEASE_NAME_MAX: usize = 53;
const VALUES_INVALID: &str = "the values are not valid YAML";

static RELEASE_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$")
        .expect("valid pattern")
});

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChartRef {
    pub repo: String,
    pub chart: String,
    pub version: String,
}

/// Values can hold secrets, so `Debug` shows only their size.
#[derive(Clone, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HelmInstallRequest {
    pub namespace: String,
    /// `None` or empty: helm generates one.
    pub release_name: Option<String>,
    pub chart: ChartRef,
    /// YAML, may be empty.
    pub values: String,
    pub create_namespace: bool,
    pub wait: bool,
}

/// Values can hold secrets, so `Debug` shows only their size.
#[derive(Clone, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HelmUpgradeRequest {
    pub namespace: String,
    pub release: String,
    pub chart: ChartRef,
    /// The whole values set; nothing is reused.
    pub values: String,
    pub wait: bool,
}

impl fmt::Debug for HelmInstallRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HelmInstallRequest")
            .field("namespace", &self.namespace)
            .field("release_name", &self.release_name)
            .field("chart", &self.chart)
            .field("values", &format_args!("{} bytes", self.values.len()))
            .field("create_namespace", &self.create_namespace)
            .field("wait", &self.wait)
            .finish()
    }
}

impl fmt::Debug for HelmUpgradeRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HelmUpgradeRequest")
            .field("namespace", &self.namespace)
            .field("release", &self.release)
            .field("chart", &self.chart)
            .field("values", &format_args!("{} bytes", self.values.len()))
            .field("wait", &self.wait)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HelmPreview {
    pub release_name: String,
    pub manifest: String,
    pub notes: Option<String>,
}

/// One YAML mapping, or nothing at all.
pub(crate) fn check_values(values: &str) -> CoreResult<()> {
    let mut mappings = 0;
    for document in serde_yaml_ng::Deserializer::from_str(values) {
        // `?` stops at the first error, which the iterator would repeat forever.
        let value = serde_yaml_ng::Value::deserialize(document)
            .map_err(|e| invalid(with_location(VALUES_INVALID, &e)))?;
        match value {
            serde_yaml_ng::Value::Null => {}
            serde_yaml_ng::Value::Mapping(_) => mappings += 1,
            _ => {
                return Err(invalid(
                    "the values must be a YAML mapping, such as `replicas: 2`",
                ))
            }
        }
    }
    if mappings > 1 {
        return Err(invalid("the values must be one YAML document"));
    }
    Ok(())
}

/// Lowercase RFC 1123, at most 53 characters, as helm requires.
pub(crate) fn check_release_name(name: &str) -> CoreResult<()> {
    if name.len() <= RELEASE_NAME_MAX && RELEASE_NAME.is_match(name) {
        Ok(())
    } else {
        Err(invalid(
            "the release name must be at most 53 lowercase letters, digits, '-' or '.', \
             and start and end with a letter or digit",
        ))
    }
}

/// The values for one helm run, in a `0600` file under `<data>/runtime/` that is removed
/// when this is dropped, whatever happened (spec §5.3).
pub(crate) struct ValuesFile {
    path: PathBuf,
}

impl ValuesFile {
    pub(crate) fn write(dir: &Path, values: &str) -> CoreResult<ValuesFile> {
        let path = dir.join(format!("helm-values-{}.yaml", random_hex()));
        let failed = |e: std::io::Error| {
            IpcError::new(
                ErrorCode::Internal,
                format!("the values file could not be written: {e}"),
            )
        };
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut handle = options.open(&path).map_err(failed)?;
        let file = ValuesFile { path };
        handle.write_all(values.as_bytes()).map_err(failed)?;
        Ok(file)
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for ValuesFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Run {
    Action,
    /// A server-side dry run, which creates nothing and so has nothing to wait for.
    Preview,
}

fn finish(call: &mut Vec<OsString>, major: HelmMajor, wait: bool, run: Run) {
    match run {
        Run::Action if wait => call.push(major.wait_flag().into()),
        Run::Action => {}
        Run::Preview => call.extend(args(&["--dry-run=server", "--output=json"])),
    }
}

fn release_name(request: &HelmInstallRequest) -> Option<&str> {
    request
        .release_name
        .as_deref()
        .filter(|name| !name.is_empty())
}

pub(crate) fn install_args(
    request: &HelmInstallRequest,
    chart: &str,
    kubeconfig: &Path,
    values: &Path,
    major: HelmMajor,
    run: Run,
) -> Vec<OsString> {
    let mut call = args(&[
        "install",
        release_name(request).unwrap_or("--generate-name"),
        chart,
    ]);
    call.extend(cluster_args(kubeconfig, &request.namespace));
    call.push(flag("version", &request.chart.version));
    call.push(flag("values", values));
    if request.create_namespace {
        call.push("--create-namespace".into());
    }
    finish(&mut call, major, request.wait, run);
    call
}

pub(crate) fn upgrade_args(
    request: &HelmUpgradeRequest,
    chart: &str,
    kubeconfig: &Path,
    values: &Path,
    major: HelmMajor,
    run: Run,
) -> Vec<OsString> {
    let mut call = args(&["upgrade", request.release.as_str(), chart]);
    call.extend(cluster_args(kubeconfig, &request.namespace));
    call.push(flag("version", &request.chart.version));
    call.push(flag("values", values));
    // Without it, helm reuses the old values whenever the file is empty.
    call.push("--reset-values".into());
    finish(&mut call, major, request.wait, run);
    call
}

pub(crate) fn rollback_args(
    release: &str,
    revision: u32,
    kubeconfig: &Path,
    namespace: &str,
    major: HelmMajor,
    wait: bool,
) -> Vec<OsString> {
    let revision = revision.to_string();
    let mut call = args(&["rollback", release, revision.as_str()]);
    call.extend(cluster_args(kubeconfig, namespace));
    finish(&mut call, major, wait, Run::Action);
    call
}

pub(crate) fn uninstall_args(
    release: &str,
    kubeconfig: &Path,
    namespace: &str,
    major: HelmMajor,
    wait: bool,
) -> Vec<OsString> {
    let mut call = args(&["uninstall", release]);
    call.extend(cluster_args(kubeconfig, namespace));
    finish(&mut call, major, wait, Run::Action);
    call
}

pub(crate) fn parse_preview(stdout: &[u8]) -> CoreResult<HelmPreview> {
    let value: Value = parse_json("dry run", stdout)?;
    let text = |field: &Value| {
        field
            .as_str()
            .filter(|text| !text.trim().is_empty())
            .map(str::to_owned)
    };
    Ok(HelmPreview {
        release_name: text(&value["name"]).unwrap_or_default(),
        manifest: value["manifest"].as_str().unwrap_or_default().to_owned(),
        notes: text(&value["info"]["notes"]),
    })
}

/// Appends `line` and keeps only the last `STDERR_KEPT` bytes.
pub(crate) fn keep_end(kept: &mut Vec<u8>, line: &[u8]) {
    kept.extend_from_slice(line);
    kept.push(b'\n');
    if kept.len() > STDERR_KEPT {
        let cut = kept.len() - STDERR_KEPT;
        kept.drain(..cut);
    }
}

/// Hands helm's lines to a session: the first 4 MiB, then one note. A session whose page
/// went away is stopped by the app, so a failed send is ignored here.
pub(crate) struct Forwarder {
    output: mpsc::Sender<SessionOutput>,
    sent: usize,
    noted: bool,
    pub(crate) stderr: Vec<u8>,
}

impl Forwarder {
    pub(crate) fn new(output: mpsc::Sender<SessionOutput>) -> Forwarder {
        Forwarder {
            output,
            sent: 0,
            noted: false,
            stderr: Vec::new(),
        }
    }

    pub(crate) async fn line(&mut self, line: OutputLine) {
        if line.stream == Stream::Stderr {
            keep_end(&mut self.stderr, &line.bytes);
        }
        let size = line.bytes.len() + 1;
        if self.sent + size > OUTPUT_LIMIT {
            if !self.noted {
                self.noted = true;
                let _ = self
                    .output
                    .send(SessionOutput::Data(OUTPUT_NOTE.to_vec()))
                    .await;
            }
            return;
        }
        self.sent += size;
        let mut bytes = line.bytes;
        bytes.push(b'\n');
        let _ = self.output.send(SessionOutput::Data(bytes)).await;
    }
}

/// The checks an install makes before helm runs, and the chart in helm's form.
fn check_install(request: &HelmInstallRequest) -> CoreResult<String> {
    check_namespace(&request.namespace)?;
    if let Some(name) = release_name(request) {
        check_release_name(name)?;
    }
    check_version(&request.chart.version)?;
    check_values(&request.values)?;
    chart_name(&request.chart.repo, &request.chart.chart)
}

fn check_upgrade(request: &HelmUpgradeRequest) -> CoreResult<String> {
    check_namespace(&request.namespace)?;
    check_name("release", &request.release)?;
    check_version(&request.chart.version)?;
    check_values(&request.values)?;
    chart_name(&request.chart.repo, &request.chart.chart)
}

impl AppCore {
    /// Registers a session that runs helm with `call`, and returns its id. The session
    /// sends `started`, helm's lines, then `exited` with code 0 or `failed`. `values` is
    /// deleted before the last event.
    fn start_action(
        &self,
        id: &ClusterId,
        helm: HelmBinary,
        call: Vec<OsString>,
        values: Option<ValuesFile>,
        output: mpsc::Sender<SessionOutput>,
    ) -> CoreResult<String> {
        let token = self.cluster_cancel_token(id)?;
        let guard = self.sessions().register(token.clone(), None);
        let session = guard.id().to_owned();
        let mut spec = ProcessSpec::new(&helm.path, call, ACTION_LIMIT);
        spec.env = self.helm_env();
        tokio::spawn(async move {
            let started = SessionEvent::Started { tty: false };
            let _ = output.send(SessionOutput::Event(started)).await;
            let (lines, mut received) = mpsc::channel(LINE_BACKLOG);
            let run = process::run(spec, Output::Stream(lines), token);
            tokio::pin!(run);
            let mut forwarder = Forwarder::new(output.clone());
            let result = loop {
                tokio::select! {
                    Some(line) = received.recv() => forwarder.line(line).await,
                    result = &mut run => break result,
                }
            };
            // Lines still queued when helm ended.
            while let Ok(line) = received.try_recv() {
                forwarder.line(line).await;
            }
            drop(values);
            let last = match result {
                Ok(done) if done.success() => SessionEvent::Exited { code: Some(0) },
                Ok(done) => SessionEvent::Failed {
                    error: helm_failure(&forwarder.stderr, done.code),
                    pod_events: Vec::new(),
                },
                Err(error) => SessionEvent::Failed {
                    error: error.into(),
                    pod_events: Vec::new(),
                },
            };
            let _ = output.send(SessionOutput::Event(last)).await;
            drop(guard);
        });
        Ok(session)
    }

    pub async fn helm_install_preview(
        &self,
        id: &ClusterId,
        request: &HelmInstallRequest,
    ) -> CoreResult<HelmPreview> {
        let chart = check_install(request)?;
        let helm = self.helm_binary().await?;
        let kubeconfig = self.cluster_kubeconfig_path(id)?;
        let values = ValuesFile::write(self.helm().runtime_dir(), &request.values)?;
        let call = install_args(
            request,
            &chart,
            &kubeconfig,
            values.path(),
            helm.major,
            Run::Preview,
        );
        let stdout = self.helm_read(&helm, call).await;
        drop(values);
        parse_preview(&stdout?)
    }

    pub async fn helm_upgrade_preview(
        &self,
        id: &ClusterId,
        request: &HelmUpgradeRequest,
    ) -> CoreResult<HelmPreview> {
        let chart = check_upgrade(request)?;
        let helm = self.helm_binary().await?;
        let kubeconfig = self.cluster_kubeconfig_path(id)?;
        let values = ValuesFile::write(self.helm().runtime_dir(), &request.values)?;
        let call = upgrade_args(
            request,
            &chart,
            &kubeconfig,
            values.path(),
            helm.major,
            Run::Preview,
        );
        let stdout = self.helm_read(&helm, call).await;
        drop(values);
        parse_preview(&stdout?)
    }

    pub async fn helm_install_start(
        &self,
        id: &ClusterId,
        request: &HelmInstallRequest,
        output: mpsc::Sender<SessionOutput>,
    ) -> CoreResult<String> {
        let chart = check_install(request)?;
        let helm = self.helm_binary().await?;
        let kubeconfig = self.cluster_kubeconfig_path(id)?;
        let values = ValuesFile::write(self.helm().runtime_dir(), &request.values)?;
        let call = install_args(
            request,
            &chart,
            &kubeconfig,
            values.path(),
            helm.major,
            Run::Action,
        );
        self.start_action(id, helm, call, Some(values), output)
    }

    pub async fn helm_upgrade_start(
        &self,
        id: &ClusterId,
        request: &HelmUpgradeRequest,
        output: mpsc::Sender<SessionOutput>,
    ) -> CoreResult<String> {
        let chart = check_upgrade(request)?;
        let helm = self.helm_binary().await?;
        let kubeconfig = self.cluster_kubeconfig_path(id)?;
        let values = ValuesFile::write(self.helm().runtime_dir(), &request.values)?;
        let call = upgrade_args(
            request,
            &chart,
            &kubeconfig,
            values.path(),
            helm.major,
            Run::Action,
        );
        self.start_action(id, helm, call, Some(values), output)
    }

    pub async fn helm_rollback_start(
        &self,
        id: &ClusterId,
        namespace: &str,
        release: &str,
        revision: u32,
        wait: bool,
        output: mpsc::Sender<SessionOutput>,
    ) -> CoreResult<String> {
        check_namespace(namespace)?;
        check_name("release", release)?;
        if revision == 0 {
            return Err(invalid("the revision must be 1 or more"));
        }
        let helm = self.helm_binary().await?;
        let kubeconfig = self.cluster_kubeconfig_path(id)?;
        let call = rollback_args(release, revision, &kubeconfig, namespace, helm.major, wait);
        self.start_action(id, helm, call, None, output)
    }

    pub async fn helm_uninstall_start(
        &self,
        id: &ClusterId,
        namespace: &str,
        release: &str,
        wait: bool,
        output: mpsc::Sender<SessionOutput>,
    ) -> CoreResult<String> {
        check_namespace(namespace)?;
        check_name("release", release)?;
        let helm = self.helm_binary().await?;
        let kubeconfig = self.cluster_kubeconfig_path(id)?;
        let call = uninstall_args(release, &kubeconfig, namespace, helm.major, wait);
        self.start_action(id, helm, call, None, output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KUBECONFIG: &str = "/data/runtime/c.yaml";
    const VALUES: &str = "/data/runtime/helm-values-1.yaml";
    const CHART: &str = "fixture/skopos-fixture";

    fn install() -> HelmInstallRequest {
        HelmInstallRequest {
            namespace: "skopos-test-helm".into(),
            release_name: Some("rel".into()),
            chart: ChartRef {
                repo: "fixture".into(),
                chart: "skopos-fixture".into(),
                version: "0.1.0".into(),
            },
            values: "message: hi\n".into(),
            create_namespace: false,
            wait: false,
        }
    }

    fn upgrade() -> HelmUpgradeRequest {
        HelmUpgradeRequest {
            namespace: "skopos-test-helm".into(),
            release: "rel".into(),
            chart: ChartRef {
                repo: "fixture".into(),
                chart: "skopos-fixture".into(),
                version: "0.2.0".into(),
            },
            values: String::new(),
            wait: false,
        }
    }

    fn texts(call: &[OsString]) -> Vec<String> {
        call.iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect()
    }

    fn install_call(request: &HelmInstallRequest, major: HelmMajor, run: Run) -> Vec<String> {
        let call = install_args(
            request,
            CHART,
            Path::new(KUBECONFIG),
            Path::new(VALUES),
            major,
            run,
        );
        texts(&call)
    }

    fn upgrade_call(request: &HelmUpgradeRequest, major: HelmMajor, run: Run) -> Vec<String> {
        let call = upgrade_args(
            request,
            CHART,
            Path::new(KUBECONFIG),
            Path::new(VALUES),
            major,
            run,
        );
        texts(&call)
    }

    #[test]
    fn values_must_be_one_yaml_mapping_or_nothing() {
        for good in [
            "",
            "\n",
            "# only a comment\n",
            "a: 1\n",
            "a: 1\n---\n",
            "---\na: 1\n",
            "a:\n  b: [1, 2]\n",
        ] {
            check_values(good).unwrap();
        }
        let error = check_values("a: [\n").unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput);
        assert!(
            error
                .message
                .starts_with("the values are not valid YAML at line"),
            "{}",
            error.message
        );
        assert!(error.message.contains("column"), "{}", error.message);
        for bad in ["- a\n- b\n", "just text\n", "1\n", "a: 1\n---\nb: 2\n"] {
            assert_eq!(
                check_values(bad).unwrap_err().code,
                ErrorCode::InvalidInput,
                "{bad}"
            );
        }
    }

    #[test]
    fn release_names_follow_rfc_1123_and_53_characters() {
        let longest = "a".repeat(53);
        for good in ["rel", "a", "my-release.v2", longest.as_str()] {
            check_release_name(good).unwrap();
        }
        let too_long = "a".repeat(54);
        for bad in [
            "",
            "-rel",
            "rel-",
            "Rel",
            "rel_1",
            "rel..x",
            ".rel",
            too_long.as_str(),
        ] {
            assert_eq!(
                check_release_name(bad).unwrap_err().code,
                ErrorCode::InvalidInput,
                "{bad}"
            );
        }
    }

    #[test]
    fn each_value_stays_inside_its_flag() {
        let mut request = install();
        request.chart.version = "--set=a=b".into();
        let call = install_call(&request, HelmMajor::V4, Run::Action);
        assert!(call.contains(&"--version=--set=a=b".to_owned()), "{call:?}");
        assert!(!call.iter().any(|arg| arg == "--set=a=b"), "{call:?}");
    }

    #[test]
    fn an_install_names_its_release_or_has_helm_generate_one() {
        let call = install_call(&install(), HelmMajor::V3, Run::Action);
        assert_eq!(
            call,
            [
                "install",
                "rel",
                CHART,
                "--kubeconfig=/data/runtime/c.yaml",
                "--namespace=skopos-test-helm",
                "--version=0.1.0",
                "--values=/data/runtime/helm-values-1.yaml",
            ]
        );
        let mut request = install();
        request.release_name = Some(String::new());
        request.create_namespace = true;
        request.wait = true;
        let call = install_call(&request, HelmMajor::V3, Run::Action);
        assert_eq!(call[..3], ["install", "--generate-name", CHART]);
        assert!(
            call.ends_with(&["--create-namespace".to_owned(), "--wait".to_owned()]),
            "{call:?}"
        );
        request.release_name = None;
        let call = install_call(&request, HelmMajor::V4, Run::Action);
        assert_eq!(call[1], "--generate-name");
        assert_eq!(call.last().map(String::as_str), Some("--wait=watcher"));
    }

    #[test]
    fn an_upgrade_resets_to_the_values_given() {
        let call = upgrade_call(&upgrade(), HelmMajor::V4, Run::Action);
        assert_eq!(
            call,
            [
                "upgrade",
                "rel",
                CHART,
                "--kubeconfig=/data/runtime/c.yaml",
                "--namespace=skopos-test-helm",
                "--version=0.2.0",
                "--values=/data/runtime/helm-values-1.yaml",
                "--reset-values",
            ]
        );
        assert!(
            !call.iter().any(|arg| arg.contains("reuse-values")),
            "{call:?}"
        );
    }

    #[test]
    fn previews_dry_run_on_the_server_and_never_wait() {
        let dry_run = ["--dry-run=server".to_owned(), "--output=json".to_owned()];
        let mut request = install();
        request.wait = true;
        let call = install_call(&request, HelmMajor::V4, Run::Preview);
        assert!(call.ends_with(&dry_run), "{call:?}");
        assert!(
            !call.iter().any(|arg| arg.starts_with("--wait")),
            "{call:?}"
        );
        let mut request = upgrade();
        request.wait = true;
        let call = upgrade_call(&request, HelmMajor::V3, Run::Preview);
        assert!(call.ends_with(&dry_run), "{call:?}");
        assert!(
            !call.iter().any(|arg| arg.starts_with("--wait")),
            "{call:?}"
        );
    }

    #[test]
    fn rollback_and_uninstall_take_their_helms_wait_flag() {
        let call = texts(&rollback_args(
            "rel",
            1,
            Path::new(KUBECONFIG),
            "ns",
            HelmMajor::V3,
            true,
        ));
        assert_eq!(
            call,
            [
                "rollback",
                "rel",
                "1",
                "--kubeconfig=/data/runtime/c.yaml",
                "--namespace=ns",
                "--wait"
            ]
        );
        let call = texts(&uninstall_args(
            "rel",
            Path::new(KUBECONFIG),
            "ns",
            HelmMajor::V4,
            true,
        ));
        assert_eq!(
            call,
            [
                "uninstall",
                "rel",
                "--kubeconfig=/data/runtime/c.yaml",
                "--namespace=ns",
                "--wait=watcher"
            ]
        );
        let call = texts(&uninstall_args(
            "rel",
            Path::new(KUBECONFIG),
            "ns",
            HelmMajor::V4,
            false,
        ));
        assert_eq!(call.len(), 4);
    }

    #[test]
    fn a_preview_reads_the_name_manifest_and_notes() {
        let stdout = br#"{"name":"skopos-fixture-1794191151","info":{"status":"pending-install","notes":"Release x holds hello."},"manifest":"---\nkind: ConfigMap\n","namespace":"ns","version":1,"chart":{},"apply_method":"ssa"}"#;
        assert_eq!(
            parse_preview(stdout).unwrap(),
            HelmPreview {
                release_name: "skopos-fixture-1794191151".into(),
                manifest: "---\nkind: ConfigMap\n".into(),
                notes: Some("Release x holds hello.".into()),
            }
        );
        let preview = parse_preview(br#"{"name":"n","info":{"notes":""},"manifest":""}"#).unwrap();
        assert_eq!(preview.notes, None);
        assert_eq!(
            parse_preview(b"no json").unwrap_err().code,
            ErrorCode::Internal
        );
    }

    #[test]
    fn a_values_file_is_private_and_removed_when_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let file = ValuesFile::write(dir.path(), "a: 1\n").unwrap();
        let path = file.path().to_path_buf();
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        assert!(
            name.starts_with("helm-values-") && name.ends_with(".yaml"),
            "{name}"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "a: 1\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let other = ValuesFile::write(dir.path(), "").unwrap();
        assert_ne!(other.path(), path);
        drop(file);
        assert!(!path.exists());
        let error = ValuesFile::write(&dir.path().join("missing"), "a: 1")
            .err()
            .unwrap();
        assert_eq!(error.code, ErrorCode::Internal);
    }

    fn line(stream: Stream, text: &str) -> OutputLine {
        OutputLine {
            stream,
            bytes: text.as_bytes().to_vec(),
        }
    }

    #[tokio::test]
    async fn output_past_the_limit_is_dropped_after_one_note() {
        let (tx, mut rx) = mpsc::channel(1024);
        let mut forwarder = Forwarder::new(tx);
        // The runner cuts lines at 64 KiB, so 64 of these fill the 4 MiB.
        let long = "x".repeat(65535);
        for _ in 0..70 {
            forwarder.line(line(Stream::Stdout, &long)).await;
        }
        forwarder.line(line(Stream::Stderr, "Error: boom")).await;
        assert!(forwarder.stderr.ends_with(b"Error: boom\n"));
        drop(forwarder);
        let mut chunks = Vec::new();
        while let Some(SessionOutput::Data(bytes)) = rx.recv().await {
            chunks.push(bytes);
        }
        assert_eq!(chunks.len(), 65);
        assert_eq!(chunks[64], OUTPUT_NOTE);
        let shown: usize = chunks[..64].iter().map(Vec::len).sum();
        assert_eq!(shown, OUTPUT_LIMIT);
        assert!(chunks[0].ends_with(b"x\n"));
    }

    #[test]
    fn kept_stderr_keeps_its_last_megabyte() {
        let mut kept = Vec::new();
        let chunk = vec![b'a'; 1000];
        for _ in 0..2000 {
            keep_end(&mut kept, &chunk);
        }
        keep_end(&mut kept, b"Error: UPGRADE FAILED: boom");
        assert_eq!(kept.len(), STDERR_KEPT);
        assert!(kept.ends_with(b"Error: UPGRADE FAILED: boom\n"));
        assert_eq!(helm_failure(&kept, Some(1)).message, "UPGRADE FAILED: boom");
    }
}
