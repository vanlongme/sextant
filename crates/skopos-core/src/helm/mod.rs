//! Helm (F15). Every operation runs one `helm` process with an argument array, never a
//! shell. helm keeps its own config, so the repos match the user's `helm` CLI. Cluster
//! commands pass the per-context kubeconfig that F3 writes.
// Tasks 2-4 of the Helm plan call these helpers; Task 4 removes this line.
#![allow(dead_code)]

use std::cmp::Ordering;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use regex::Regex;
use serde::Serialize;
use tokio_util::sync::CancellationToken;
use ts_rs::TS;

use crate::app_core::AppCore;
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::process::{self, Output, ProcessOutput, ProcessSpec};
use crate::resources::invalid;
use crate::tools::{ToolName, ToolSource};

/// The oldest helm 3 release that has every flag this module passes.
pub const HELM_MINIMUM: &str = "3.13";
/// Read commands (spec §5.3).
pub(crate) const READ_TIMEOUT: Duration = Duration::from_secs(60);
const STDOUT_LIMIT: usize = 64 << 20;
const STDERR_LIMIT: usize = 1 << 20;

static NAMESPACE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$").expect("valid pattern"));
static NO_SUCH_REVISION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"release has no \d+ version").expect("valid pattern"));

/// What helm prints when it cannot reach a cluster or a repository.
const UNREACHABLE: [&str; 8] = [
    "kubernetes cluster unreachable",
    "is not a valid chart repository or cannot be reached",
    "connection refused",
    "no such host",
    "i/o timeout",
    "tls handshake timeout",
    "network is unreachable",
    "connection reset",
];
const CONFLICT: [&str; 2] = ["already exists", "a name that is still in use"];
/// helm's words for a missing repo or revision include more than "not found".
const NOT_FOUND: [&str; 3] = [
    "not found",
    "no repo named",
    "no repositories found matching",
];

/// What `helm_version` reports.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HelmInfo {
    pub path: String,
    /// For example `v4.3.1`.
    pub version: String,
    #[ts(type = "3 | 4")]
    pub major: u8,
    pub source: ToolSource,
}

/// helm's three folders. Tests point them at temp directories; the app leaves them unset,
/// so helm uses the user's own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HelmHomes {
    pub config: PathBuf,
    pub cache: PathBuf,
    pub data: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HelmMajor {
    V3,
    V4,
}

impl HelmMajor {
    /// The flag that makes an action wait until its resources are ready.
    pub(crate) fn wait_flag(self) -> &'static str {
        match self {
            HelmMajor::V3 => "--wait",
            HelmMajor::V4 => "--wait=watcher",
        }
    }

    pub(crate) fn number(self) -> u8 {
        match self {
            HelmMajor::V3 => 3,
            HelmMajor::V4 => 4,
        }
    }
}

/// A version read the way chart authors write them: an optional `v`, one to three
/// numbers, and an optional pre-release. Build metadata is dropped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LooseVersion {
    pub(crate) numbers: [u64; 3],
    pub(crate) pre: Option<String>,
}

impl LooseVersion {
    pub(crate) fn parse(text: &str) -> Option<LooseVersion> {
        let text = text.trim();
        let text = text.strip_prefix('v').unwrap_or(text);
        let text = text.split_once('+').map_or(text, |(version, _)| version);
        let (core, pre) = match text.split_once('-') {
            Some((_, "")) => return None,
            Some((core, pre)) => (core, Some(pre.to_owned())),
            None => (text, None),
        };
        let parts: Vec<&str> = core.split('.').collect();
        if parts.len() > 3 {
            return None;
        }
        let mut numbers = [0; 3];
        for (slot, part) in numbers.iter_mut().zip(&parts) {
            if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            *slot = part.parse().ok()?;
        }
        Some(LooseVersion { numbers, pre })
    }

    /// Semver precedence: a release comes after its pre-releases.
    pub(crate) fn compare(&self, other: &LooseVersion) -> Ordering {
        self.numbers
            .cmp(&other.numbers)
            .then_with(|| match (&self.pre, &other.pre) {
                (None, None) => Ordering::Equal,
                (None, Some(_)) => Ordering::Greater,
                (Some(_), None) => Ordering::Less,
                (Some(left), Some(right)) => compare_pre(left, right),
            })
    }
}

/// Dot-separated parts in turn: numbers by value and below words, words by text, and a
/// shorter list first when one is the start of the other.
fn compare_pre(left: &str, right: &str) -> Ordering {
    let mut left = left.split('.');
    let mut right = right.split('.');
    loop {
        let order = match (left.next(), right.next()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(a), Some(b)) => match (a.parse::<u64>(), b.parse::<u64>()) {
                (Ok(a), Ok(b)) => a.cmp(&b),
                (Ok(_), Err(_)) => Ordering::Less,
                (Err(_), Ok(_)) => Ordering::Greater,
                (Err(_), Err(_)) => a.cmp(b),
            },
        };
        if order != Ordering::Equal {
            return order;
        }
    }
}

fn helm_missing(message: String) -> IpcError {
    IpcError::new(ErrorCode::ToolMissing, message).with_details(ToolName::Helm.as_str())
}

/// helm 3.13 and later 3.x, and every 4.x.
pub(crate) fn helm_major(version: &str) -> CoreResult<HelmMajor> {
    match LooseVersion::parse(version).map(|parsed| parsed.numbers) {
        Some([3, minor, _]) if minor >= 13 => Ok(HelmMajor::V3),
        Some([4, _, _]) => Ok(HelmMajor::V4),
        Some([0..=3, _, _]) => Err(helm_missing(format!(
            "helm {version} is too old: {HELM_MINIMUM} or later is needed. \
             Download it, or set a newer helm in Preferences."
        ))),
        _ => Err(helm_missing(format!(
            "helm {version} is not supported: use helm {HELM_MINIMUM} or later, or helm 4"
        ))),
    }
}

/// `--name=value` as one argument, so a value that starts with `-` stays a value.
pub(crate) fn flag(name: &str, value: impl AsRef<OsStr>) -> OsString {
    let mut arg = OsString::from(format!("--{name}="));
    arg.push(value);
    arg
}

/// A repo, chart or release name that helm takes as a positional argument. One that starts
/// with `-` would be read as a flag; a path separator would name another chart or file.
pub(crate) fn check_name(what: &str, name: &str) -> CoreResult<()> {
    let bad = name.is_empty()
        || name.starts_with('-')
        || name.contains(['/', '\\'])
        || name.chars().any(char::is_control);
    if bad {
        Err(invalid(format!("the {what} name is not valid: {name:?}")))
    } else {
        Ok(())
    }
}

/// A Kubernetes namespace name: a DNS label.
pub(crate) fn check_namespace(namespace: &str) -> CoreResult<()> {
    if namespace.len() <= 63 && NAMESPACE.is_match(namespace) {
        Ok(())
    } else {
        Err(invalid(format!(
            "the namespace is not valid: {namespace:?}"
        )))
    }
}

/// The code a helm error message maps to (spec §5.3), first match wins.
pub(crate) fn classify(message: &str) -> ErrorCode {
    let lower = message.to_lowercase();
    let has = |patterns: &[&str]| patterns.iter().any(|pattern| lower.contains(pattern));
    if has(&UNREACHABLE) {
        ErrorCode::Unreachable
    } else if lower.contains("forbidden") {
        ErrorCode::Forbidden
    } else if has(&CONFLICT) {
        ErrorCode::Conflict
    } else if has(&NOT_FOUND) || NO_SUCH_REVISION.is_match(&lower) {
        ErrorCode::NotFound
    } else {
        ErrorCode::Internal
    }
}

/// helm's error: `message` is the text of its last `Error:` line, or its last line when
/// there is none, and `details` all of stderr. Both pass through the one sanitizer.
pub(crate) fn helm_failure(stderr: &[u8], code: Option<i32>) -> IpcError {
    let text = String::from_utf8_lossy(stderr);
    let lines = || {
        text.lines()
            .rev()
            .map(str::trim)
            .filter(|line| !line.is_empty())
    };
    let message = lines()
        .find_map(|line| {
            line.strip_prefix("Error:")
                .map(str::trim)
                .filter(|rest| !rest.is_empty())
        })
        .or_else(|| lines().next())
        .map(str::to_owned)
        .unwrap_or_else(|| match code {
            Some(code) => format!("helm exited with code {code} and printed no error"),
            None => "helm was stopped by a signal and printed no error".to_owned(),
        });
    let error = IpcError::new(classify(&message), message);
    if text.trim().is_empty() {
        error
    } else {
        error.with_details(text.trim_end())
    }
}

/// helm's stdout when it succeeded and printed all of it.
pub(crate) fn succeeded(output: ProcessOutput) -> CoreResult<Vec<u8>> {
    if !output.success() {
        return Err(helm_failure(&output.stderr, output.code));
    }
    if output.stdout_truncated {
        return Err(IpcError::new(
            ErrorCode::Internal,
            "helm printed more than 64 MiB, which is more than this screen reads",
        ));
    }
    Ok(output.stdout)
}

/// helm found, with a version this module runs.
#[derive(Debug, Clone)]
pub(crate) struct HelmBinary {
    pub(crate) path: PathBuf,
    pub(crate) version: String,
    pub(crate) major: HelmMajor,
    pub(crate) source: ToolSource,
}

/// What `AppCore` keeps for helm.
pub(crate) struct Helm {
    runtime_dir: PathBuf,
    homes: Mutex<Option<HelmHomes>>,
}

impl Helm {
    pub(crate) fn new(runtime_dir: PathBuf) -> Helm {
        Helm {
            runtime_dir,
            homes: Mutex::new(None),
        }
    }

    /// `<data>/runtime`, where values files go.
    pub(crate) fn runtime_dir(&self) -> &Path {
        &self.runtime_dir
    }
}

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl AppCore {
    /// The helm to run, or `ToolMissing` with `details: "helm"`.
    pub(crate) async fn helm_binary(&self) -> CoreResult<HelmBinary> {
        let tool = self.tool_resolve(ToolName::Helm).await?;
        let major = helm_major(&tool.version)?;
        Ok(HelmBinary {
            path: tool.path,
            version: tool.version,
            major,
            source: tool.source,
        })
    }

    pub async fn helm_version(&self) -> CoreResult<HelmInfo> {
        let helm = self.helm_binary().await?;
        Ok(HelmInfo {
            path: helm.path.to_string_lossy().into_owned(),
            version: helm.version,
            major: helm.major.number(),
            source: helm.source,
        })
    }

    pub fn set_helm_homes_for_test(&self, homes: HelmHomes) {
        *lock(&self.helm().homes) = Some(homes);
    }

    /// The proxy variables, and the test folders when they are set.
    pub(crate) fn helm_env(&self) -> Vec<(OsString, OsString)> {
        let mut env = self.tool_env();
        if let Some(homes) = lock(&self.helm().homes).clone() {
            env.push(("HELM_CONFIG_HOME".into(), homes.config.into()));
            env.push(("HELM_CACHE_HOME".into(), homes.cache.into()));
            env.push(("HELM_DATA_HOME".into(), homes.data.into()));
        }
        env
    }

    /// Runs helm to the end and returns its output, whatever its exit code.
    pub(crate) async fn helm_output(
        &self,
        helm: &HelmBinary,
        args: Vec<OsString>,
        timeout: Duration,
        stdin: Option<Vec<u8>>,
        cancel: CancellationToken,
    ) -> CoreResult<ProcessOutput> {
        let mut spec = ProcessSpec::new(&helm.path, args, timeout);
        spec.env = self.helm_env();
        spec.stdin = stdin;
        let output = Output::Capture {
            stdout_limit: STDOUT_LIMIT,
            stderr_limit: STDERR_LIMIT,
        };
        Ok(process::run(spec, output, cancel).await?)
    }

    /// A read command: helm's stdout, or the error its stderr maps to.
    pub(crate) async fn helm_read(
        &self,
        helm: &HelmBinary,
        args: Vec<OsString>,
    ) -> CoreResult<Vec<u8>> {
        let output = self
            .helm_output(helm, args, READ_TIMEOUT, None, CancellationToken::new())
            .await?;
        succeeded(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loose_versions_read_what_helm_and_chart_authors_write() {
        let parse = |text| LooseVersion::parse(text).map(|v| (v.numbers, v.pre));
        assert_eq!(parse("v3.13.0"), Some(([3, 13, 0], None)));
        assert_eq!(parse("4.3.1+g0f1e2d3"), Some(([4, 3, 1], None)));
        assert_eq!(parse("1.0"), Some(([1, 0, 0], None)));
        assert_eq!(parse("2"), Some(([2, 0, 0], None)));
        assert_eq!(
            parse("1.2.3-rc.1"),
            Some(([1, 2, 3], Some("rc.1".to_owned())))
        );
        for bad in [
            "", "v", "latest", "1.2.3.4", "1..2", "1.x", "1.2.3-", "-1.2",
        ] {
            assert_eq!(parse(bad), None, "{bad}");
        }
    }

    #[test]
    fn versions_order_as_semver_does() {
        let mut versions = [
            "1.0.0",
            "1.0.0-rc.10",
            "1.0.0-rc.2",
            "0.9",
            "1.0.0-alpha",
            "1.10.0",
            "1.2.0",
        ]
        .map(|text| LooseVersion::parse(text).unwrap());
        versions.sort_by(|a, b| b.compare(a));
        let texts: Vec<String> = versions
            .iter()
            .map(|v| match &v.pre {
                Some(pre) => format!("{:?}-{pre}", v.numbers),
                None => format!("{:?}", v.numbers),
            })
            .collect();
        assert_eq!(
            texts,
            [
                "[1, 10, 0]",
                "[1, 2, 0]",
                "[1, 0, 0]",
                "[1, 0, 0]-rc.10",
                "[1, 0, 0]-rc.2",
                "[1, 0, 0]-alpha",
                "[0, 9, 0]",
            ]
        );
    }

    #[test]
    fn helm_3_13_and_later_and_helm_4_are_supported() {
        assert_eq!(helm_major("v3.13.0").unwrap(), HelmMajor::V3);
        assert_eq!(helm_major("v3.22.1").unwrap(), HelmMajor::V3);
        assert_eq!(helm_major("v4.3.1").unwrap(), HelmMajor::V4);
        assert_eq!(HelmMajor::V3.wait_flag(), "--wait");
        assert_eq!(HelmMajor::V4.wait_flag(), "--wait=watcher");
        assert_eq!(HelmMajor::V3.number(), 3);
        assert_eq!(HelmMajor::V4.number(), 4);
    }

    #[test]
    fn older_and_newer_helm_is_tool_missing() {
        for version in ["v3.12.3", "v2.17.0"] {
            let error = helm_major(version).unwrap_err();
            assert_eq!(error.code, ErrorCode::ToolMissing, "{version}");
            assert_eq!(error.details.as_deref(), Some("helm"));
            assert!(error.message.contains("3.13"), "{}", error.message);
        }
        let error = helm_major("v5.0.0").unwrap_err();
        assert_eq!(error.code, ErrorCode::ToolMissing);
        assert!(error.message.contains("v5.0.0"), "{}", error.message);
        assert!(error.message.contains("helm 4"), "{}", error.message);
    }

    #[test]
    fn names_helm_could_read_as_flags_or_paths_are_refused() {
        for name in ["fixture", "my.repo_1", "Bitnami"] {
            check_name("repo", name).unwrap();
        }
        for name in ["", "-x", "--set=a", "a/b", "a\\b", "a\nb", "a\u{7}b"] {
            let error = check_name("repo", name).unwrap_err();
            assert_eq!(error.code, ErrorCode::InvalidInput, "{name:?}");
            assert!(
                error.message.starts_with("the repo name"),
                "{}",
                error.message
            );
        }
        check_namespace("default").unwrap();
        check_namespace(&"a".repeat(63)).unwrap();
        let too_long = "a".repeat(64);
        for namespace in ["", "-a", "a-", "A", "a.b", "a_b", too_long.as_str()] {
            assert_eq!(
                check_namespace(namespace).unwrap_err().code,
                ErrorCode::InvalidInput,
                "{namespace}"
            );
        }
        assert_eq!(
            flag("version", "--set=a"),
            OsString::from("--version=--set=a")
        );
    }

    #[test]
    fn helm_errors_map_to_codes_as_spec_5_3_lists() {
        let cases = [
            (r#"Kubernetes cluster unreachable: Get "https://127.0.0.1:1/version": dial tcp 127.0.0.1:1: connect: connection refused"#, ErrorCode::Unreachable),
            (r#"looks like "http://127.0.0.1:1" is not a valid chart repository or cannot be reached: Get "http://127.0.0.1:1/index.yaml": dial tcp 127.0.0.1:1: connect: connection refused"#, ErrorCode::Unreachable),
            ("looks like \"http://127.0.0.1:18765/missing\" is not a valid chart repository or cannot be reached: failed to fetch http://127.0.0.1:18765/missing/index.yaml : 404 File not found", ErrorCode::Unreachable),
            ("Get \"https://charts.example.test/index.yaml\": dial tcp: lookup charts.example.test: no such host", ErrorCode::Unreachable),
            (r#"INSTALLATION FAILED: create: failed to create: secrets is forbidden: User "system:serviceaccount:probe-rbac:viewer" cannot create resource "secrets" in API group "" in the namespace "probe-rbac""#, ErrorCode::Forbidden),
            ("repository name (fixture) already exists, please specify a different name", ErrorCode::Conflict),
            ("INSTALLATION FAILED: cannot re-use a name that is still in use", ErrorCode::Conflict),
            ("INSTALLATION FAILED: release name check failed: cannot reuse a name that is still in use", ErrorCode::Conflict),
            ("chart \"nochart\" matching 0.1.0 not found in fixture index. (try 'helm repo update'): no chart name found", ErrorCode::NotFound),
            ("release: not found", ErrorCode::NotFound),
            ("uninstall: Release not loaded: nothere: release: not found", ErrorCode::NotFound),
            ("no repo named \"missing\" found", ErrorCode::NotFound),
            ("no repositories found matching 'missing'.  Nothing will be updated", ErrorCode::NotFound),
            ("release has no 99 version", ErrorCode::NotFound),
            ("UPGRADE FAILED: template: x/templates/a.yaml:3:9: executing \"x\" at <.Values.a.b>: nil pointer evaluating", ErrorCode::Internal),
        ];
        for (message, code) in cases {
            assert_eq!(classify(message), code, "{message}");
        }
    }

    #[test]
    fn the_message_is_the_last_error_line_and_details_all_of_stderr() {
        let stderr = b"level=ERROR msg=\"release name check failed\" error=\"cannot reuse a name that is still in use\"\nError: INSTALLATION FAILED: release name check failed: cannot reuse a name that is still in use\n";
        let error = helm_failure(stderr, Some(1));
        assert_eq!(error.code, ErrorCode::Conflict);
        assert_eq!(
            error.message,
            "INSTALLATION FAILED: release name check failed: cannot reuse a name that is still in use"
        );
        assert_eq!(
            error.details.as_deref(),
            Some(String::from_utf8_lossy(stderr).trim_end())
        );

        let error = helm_failure(b"WARNING: something odd\npanic: boom\n", Some(2));
        assert_eq!(error.code, ErrorCode::Internal);
        assert_eq!(error.message, "panic: boom");

        let error = helm_failure(b"", Some(3));
        assert_eq!(
            error.message,
            "helm exited with code 3 and printed no error"
        );
        assert_eq!(error.details, None);
        let error = helm_failure(b"  \n", None);
        assert_eq!(
            error.message,
            "helm was stopped by a signal and printed no error"
        );
    }

    #[test]
    fn stderr_secrets_are_redacted() {
        let stderr = b"Error: Get \"https://x\": Authorization: Bearer abc.def.ghi failed\n";
        let error = helm_failure(stderr, Some(1));
        assert!(!error.message.contains("abc.def.ghi"), "{}", error.message);
        assert!(!error.details.unwrap().contains("abc.def.ghi"));
    }

    #[test]
    fn output_is_kept_only_when_helm_succeeded_in_full() {
        let ok = ProcessOutput {
            code: Some(0),
            stdout: b"[]".to_vec(),
            ..ProcessOutput::default()
        };
        assert_eq!(succeeded(ok.clone()).unwrap(), b"[]");
        let cut = ProcessOutput {
            stdout_truncated: true,
            ..ok
        };
        let error = succeeded(cut).unwrap_err();
        assert_eq!(error.code, ErrorCode::Internal);
        assert!(error.message.contains("64 MiB"), "{}", error.message);
        let failed = ProcessOutput {
            code: Some(1),
            stderr: b"Error: release: not found\n".to_vec(),
            ..ProcessOutput::default()
        };
        assert_eq!(succeeded(failed).unwrap_err().code, ErrorCode::NotFound);
    }
}
