//! helm and kubectl (F14): where each one is, its version, and the managed downloads.
//! Lookup touches no network.

pub mod download;
pub mod pinned;

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant, SystemTime};

use futures::future::{BoxFuture, FutureExt, Shared};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use ts_rs::TS;

use crate::app_core::{AppCore, CoreEvent};
use crate::error::{sanitize_text, CoreResult, ErrorCode, IpcError};
use crate::process::{self, Output, ProcessSpec};
use download::{DownloadLimits, ProgressGate};
use pinned::{current_platform, pinned_downloads, PinnedDownload};

const VERSION_TIMEOUT: Duration = Duration::from_secs(5);
const VERSION_OUTPUT_LIMIT: usize = 64 * 1024;
/// While downloading, progress goes out at most this often.
const PROGRESS_EVERY: Duration = Duration::from_millis(200);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ToolName {
    Helm,
    Kubectl,
}

impl ToolName {
    pub const ALL: [ToolName; 2] = [ToolName::Helm, ToolName::Kubectl];

    pub fn as_str(self) -> &'static str {
        match self {
            ToolName::Helm => "helm",
            ToolName::Kubectl => "kubectl",
        }
    }

    /// The file name on this OS.
    pub fn binary(self) -> String {
        if cfg!(windows) {
            format!("{}.exe", self.as_str())
        } else {
            self.as_str().to_owned()
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ToolSource {
    Preferences,
    Path,
    Managed,
    Missing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ToolStatus {
    pub tool: ToolName,
    pub source: ToolSource,
    pub path: Option<String>,
    /// For example `v4.3.1`.
    pub version: Option<String>,
    /// Why the tool found cannot be used, such as a Preferences path that does not exist.
    pub problem: Option<String>,
    /// `None`: no managed download for this OS and architecture.
    pub managed_version: Option<String>,
    pub managed_installed: bool,
    pub downloading: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ToolPhase {
    Downloading,
    Verifying,
    Extracting,
    Done,
    Failed,
}

/// The payload of `tools://progress`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ToolProgress {
    pub tool: ToolName,
    pub phase: ToolPhase,
    #[ts(type = "number")]
    pub received_bytes: u64,
    #[ts(type = "number | null")]
    pub total_bytes: Option<u64>,
    /// Set when `phase` is `failed`.
    pub error: Option<IpcError>,
}

/// A tool ready to run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedTool {
    pub path: PathBuf,
    pub version: String,
    pub source: ToolSource,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Located {
    pub source: ToolSource,
    pub path: Option<PathBuf>,
    pub problem: Option<String>,
}

/// F14's lookup order: the Preferences path, then `PATH`, then the managed copy. A
/// Preferences path that is set is the user's choice, so a problem with it ends the lookup.
pub fn locate(
    tool: ToolName,
    configured: Option<&str>,
    search_path: Option<&OsStr>,
    managed: Option<&Path>,
) -> Located {
    if let Some(configured) = configured {
        let path = PathBuf::from(configured);
        let problem = if !path.is_absolute() {
            Some(format!("{configured} is not an absolute path"))
        } else if !path.exists() {
            Some(format!("{configured} does not exist"))
        } else if !is_executable(&path) {
            Some(format!("{configured} is not an executable file"))
        } else {
            None
        };
        return Located {
            source: ToolSource::Preferences,
            path: Some(path),
            problem,
        };
    }
    let binary = tool.binary();
    // A relative entry would depend on the app's working directory.
    let on_path = search_path
        .into_iter()
        .flat_map(std::env::split_paths)
        .filter(|folder| folder.is_absolute())
        .map(|folder| folder.join(&binary))
        .find(|candidate| is_executable(candidate));
    if let Some(path) = on_path {
        return Located {
            source: ToolSource::Path,
            path: Some(path),
            problem: None,
        };
    }
    if let Some(path) = managed.filter(|path| is_executable(path)) {
        return Located {
            source: ToolSource::Managed,
            path: Some(path.to_path_buf()),
            problem: None,
        };
    }
    Located {
        source: ToolSource::Missing,
        path: None,
        problem: None,
    }
}

#[cfg(unix)]
fn is_executable_file(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable_file(metadata: &std::fs::Metadata) -> bool {
    metadata.is_file()
}

/// A file this OS would run: on Unix, one with an execute bit.
pub fn is_executable(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|metadata| is_executable_file(&metadata))
}

/// `current` with `extra` added at the end, leaving out folders it already has, so the
/// user's own programs win. `None` when nothing is added, or the result is not a valid `PATH`.
pub fn append_to_path(current: Option<&OsStr>, extra: &[PathBuf]) -> Option<OsString> {
    let mut folders: Vec<PathBuf> = current
        .map(|path| {
            std::env::split_paths(path)
                .filter(|folder| !folder.as_os_str().is_empty())
                .collect()
        })
        .unwrap_or_default();
    let before = folders.len();
    for folder in extra {
        if !folders.contains(folder) {
            folders.push(folder.clone());
        }
    }
    if folders.len() == before {
        return None;
    }
    std::env::join_paths(folders).ok()
}

/// The version in `tool version`'s output, such as `v4.3.1`.
pub fn parse_version(tool: ToolName, stdout: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(stdout);
    let version = match tool {
        ToolName::Helm => text.trim().to_owned(),
        ToolName::Kubectl => serde_json::from_str::<serde_json::Value>(&text)
            .ok()?
            .pointer("/clientVersion/gitVersion")?
            .as_str()?
            .to_owned(),
    };
    let well_formed = version.starts_with('v')
        && version.as_bytes().get(1).is_some_and(u8::is_ascii_digit)
        && !version.contains(|c: char| c.is_whitespace() || c == '{');
    well_formed.then_some(version)
}

/// The variables helm, a Go program, reads for its proxy. Upper case wins over lower case.
pub fn proxy_env(proxy: Option<&str>) -> Vec<(OsString, OsString)> {
    proxy
        .map(|proxy| {
            vec![
                ("HTTPS_PROXY".into(), proxy.into()),
                ("HTTP_PROXY".into(), proxy.into()),
            ]
        })
        .unwrap_or_default()
}

/// Runs `tool version` and reads the version from its output.
pub async fn read_version(
    tool: ToolName,
    path: &Path,
    cancel: &CancellationToken,
) -> Result<String, String> {
    let args: &[&str] = match tool {
        ToolName::Helm => &["version", "--template", "{{.Version}}"],
        ToolName::Kubectl => &["version", "--client", "-o", "json"],
    };
    let spec = ProcessSpec::new(path, args.iter().copied(), VERSION_TIMEOUT);
    let output = Output::Capture {
        stdout_limit: VERSION_OUTPUT_LIMIT,
        stderr_limit: VERSION_OUTPUT_LIMIT,
    };
    let output = process::run(spec, output, cancel.clone())
        .await
        .map_err(|error| error.to_string())?;
    let name = tool.as_str();
    if !output.success() {
        return Err(format!(
            "{name} version failed: {}",
            first_line(&output.stderr)
        ));
    }
    parse_version(tool, &output.stdout).ok_or_else(|| format!("{name} version printed no version"))
}

fn first_line(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let line = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("no output");
    sanitize_text(line)
}

/// How tools are found and downloaded. Tests replace it; the app keeps the default.
#[derive(Debug, Clone)]
pub struct ToolsConfig {
    pub downloads: Vec<PinnedDownload>,
    /// `None` reads `PATH` from the environment each time.
    pub search_path: Option<OsString>,
    pub limits: DownloadLimits,
    /// Tests serve downloads over plain HTTP from a local server.
    pub https_only: bool,
}

impl Default for ToolsConfig {
    fn default() -> Self {
        ToolsConfig {
            downloads: pinned_downloads(),
            search_path: None,
            limits: DownloadLimits::default(),
            https_only: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FileStamp {
    len: u64,
    modified: Option<SystemTime>,
}

pub(crate) fn stamp(path: &Path) -> Option<FileStamp> {
    let metadata = std::fs::metadata(path).ok()?;
    Some(FileStamp {
        len: metadata.len(),
        modified: metadata.modified().ok(),
    })
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

type DownloadResult = Shared<BoxFuture<'static, CoreResult<ToolStatus>>>;

struct RunningDownload {
    cancel: CancellationToken,
    result: DownloadResult,
}

/// What `AppCore` keeps for tools.
pub(crate) struct Tools {
    /// `<data>/tools`
    pub(crate) root: PathBuf,
    config: Mutex<ToolsConfig>,
    /// Versions read, by path, valid while the file keeps its size and modification time.
    versions: Mutex<HashMap<PathBuf, (FileStamp, String)>>,
    downloads: Mutex<HashMap<ToolName, RunningDownload>>,
}

impl Tools {
    pub(crate) fn new(data: &Path) -> Tools {
        Tools {
            root: data.join("tools"),
            config: Mutex::new(ToolsConfig::default()),
            versions: Mutex::new(HashMap::new()),
            downloads: Mutex::new(HashMap::new()),
        }
    }

    /// A copy, so a download keeps one config from start to end.
    pub(crate) fn config(&self) -> ToolsConfig {
        lock(&self.config).clone()
    }

    pub(crate) fn is_downloading(&self, tool: ToolName) -> bool {
        lock(&self.downloads).contains_key(&tool)
    }

    pub(crate) fn search_path(&self) -> Option<OsString> {
        lock(&self.config)
            .search_path
            .clone()
            .or_else(|| std::env::var_os("PATH"))
    }

    /// The pinned download for this OS and architecture.
    pub(crate) fn pinned(&self, tool: ToolName) -> Option<PinnedDownload> {
        let (os, arch) = current_platform()?;
        lock(&self.config)
            .downloads
            .iter()
            .find(|entry| entry.tool == tool && entry.os == os && entry.arch == arch)
            .cloned()
    }

    /// `<data>/tools/<tool>/<version>/<binary>`
    pub(crate) fn managed_path(&self, entry: &PinnedDownload) -> PathBuf {
        self.root
            .join(entry.tool.as_str())
            .join(&entry.version)
            .join(entry.tool.binary())
    }

    /// The folders of the managed copies in place, for the end of a terminal's `PATH`.
    pub(crate) fn managed_dirs(&self) -> Vec<PathBuf> {
        ToolName::ALL
            .into_iter()
            .filter_map(|tool| self.pinned(tool))
            .map(|entry| self.managed_path(&entry))
            .filter(|binary| is_executable(binary))
            .filter_map(|binary| binary.parent().map(Path::to_path_buf))
            .collect()
    }

    pub(crate) async fn version(
        &self,
        tool: ToolName,
        path: &Path,
        cancel: &CancellationToken,
    ) -> Result<String, String> {
        if let Some((cached, version)) = lock(&self.versions).get(path) {
            if stamp(path).as_ref() == Some(cached) {
                return Ok(version.clone());
            }
        }
        let version = read_version(tool, path, cancel).await?;
        self.remember_version(path, version.clone());
        Ok(version)
    }

    pub(crate) fn remember_version(&self, path: &Path, version: String) {
        if let Some(stamp) = stamp(path) {
            lock(&self.versions).insert(path.to_path_buf(), (stamp, version));
        }
    }
}

/// Sends `tools://progress` for one download.
struct Progress {
    core: AppCore,
    tool: ToolName,
    received: u64,
    total: Option<u64>,
    gate: ProgressGate,
}

impl Progress {
    fn send(&self, phase: ToolPhase, error: Option<IpcError>) {
        self.core.emit(CoreEvent::ToolProgress {
            progress: ToolProgress {
                tool: self.tool,
                phase,
                received_bytes: self.received,
                total_bytes: self.total,
                error,
            },
        });
    }

    fn downloading(&mut self, received: u64, total: Option<u64>) {
        self.received = received;
        self.total = total;
        if self.gate.ready(Instant::now()) {
            self.send(ToolPhase::Downloading, None);
        }
    }
}

/// Removes everything in the tool's folder but `keep`: older versions, and the temp files
/// and staging folders a crash left.
fn remove_other_entries(dir: &Path, keep: &str) {
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    for item in read.flatten() {
        if item.file_name() == keep {
            continue;
        }
        let path = item.path();
        let removed = match item.file_type() {
            Ok(kind) if kind.is_dir() => std::fs::remove_dir_all(&path),
            _ => std::fs::remove_file(&path),
        };
        if let Err(error) = removed {
            tracing::warn!("cannot remove {}: {error}", path.display());
        }
    }
}

struct Inspection {
    source: ToolSource,
    path: Option<PathBuf>,
    version: Option<String>,
    problem: Option<String>,
}

impl AppCore {
    /// Every tool's status. Never touches the network.
    pub async fn tools_status(&self) -> Vec<ToolStatus> {
        let mut all = Vec::new();
        for tool in ToolName::ALL {
            all.push(self.tool_status(tool).await);
        }
        all
    }

    pub async fn tool_status(&self, tool: ToolName) -> ToolStatus {
        let tools = self.tools();
        let pinned = tools.pinned(tool);
        let managed = pinned.as_ref().map(|entry| tools.managed_path(entry));
        let found = self.inspect_tool(tool, managed.as_deref()).await;
        ToolStatus {
            tool,
            source: found.source,
            path: found.path.map(|path| path.to_string_lossy().into_owned()),
            version: found.version,
            problem: found.problem,
            managed_version: pinned.map(|entry| entry.version),
            managed_installed: managed.as_deref().is_some_and(is_executable),
            downloading: tools.is_downloading(tool),
        }
    }

    /// The tool to run, or `ToolMissing` whose `details` names the tool.
    pub async fn tool_resolve(&self, tool: ToolName) -> CoreResult<ResolvedTool> {
        let tools = self.tools();
        let managed = tools.pinned(tool).map(|entry| tools.managed_path(&entry));
        let found = self.inspect_tool(tool, managed.as_deref()).await;
        let name = tool.as_str();
        match found {
            Inspection {
                source,
                path: Some(path),
                version: Some(version),
                problem: None,
            } => Ok(ResolvedTool {
                path,
                version,
                source,
            }),
            Inspection {
                problem: Some(problem),
                ..
            } => Err(IpcError::new(
                ErrorCode::ToolMissing,
                format!("{name} cannot be used: {problem}"),
            )
            .with_details(name)),
            _ => Err(IpcError::new(
                ErrorCode::ToolMissing,
                format!("{name} was not found. Set its path in Preferences or download it."),
            )
            .with_details(name)),
        }
    }

    pub fn set_tools_config_for_test(&self, config: ToolsConfig) {
        *lock(&self.tools().config) = config;
    }

    /// What helm runs with on top of the app's environment (spec §5.1).
    pub(crate) fn tool_env(&self) -> Vec<(OsString, OsString)> {
        proxy_env(self.prefs_get().http_proxy.as_deref())
    }

    async fn inspect_tool(&self, tool: ToolName, managed: Option<&Path>) -> Inspection {
        let prefs = self.prefs_get();
        let configured = match tool {
            ToolName::Helm => prefs.helm_path,
            ToolName::Kubectl => prefs.kubectl_path,
        };
        let tools = self.tools();
        let search_path = tools.search_path();
        let located = locate(tool, configured.as_deref(), search_path.as_deref(), managed);
        let checked = match (&located.path, &located.problem) {
            (Some(path), None) => Some(tools.version(tool, path, &CancellationToken::new()).await),
            _ => None,
        };
        let (version, problem) = match checked {
            Some(Ok(version)) => (Some(version), None),
            Some(Err(problem)) => (None, Some(problem)),
            None => (None, located.problem),
        };
        Inspection {
            source: located.source,
            path: located.path,
            version,
            problem,
        }
    }

    /// Installs the pinned managed copy, then resolves with the tool's status. A call while a
    /// download of the same tool runs waits for it and gets its result.
    pub async fn tools_download(&self, tool: ToolName) -> CoreResult<ToolStatus> {
        let result = {
            let mut downloads = lock(&self.tools().downloads);
            match downloads.get(&tool) {
                Some(running) => running.result.clone(),
                None => {
                    let cancel = CancellationToken::new();
                    let core = self.clone();
                    let token = cancel.clone();
                    let task = tokio::spawn(async move { core.run_download(tool, token).await });
                    let result = async move {
                        task.await.unwrap_or_else(|error| {
                            Err(IpcError::new(
                                ErrorCode::Internal,
                                format!("the download stopped: {error}"),
                            ))
                        })
                    }
                    .boxed()
                    .shared();
                    let running = RunningDownload {
                        cancel,
                        result: result.clone(),
                    };
                    downloads.insert(tool, running);
                    result
                }
            }
        };
        result.await
    }

    /// Stops the tool's download, if one runs; it then rejects with `Cancelled`.
    pub fn tools_download_cancel(&self, tool: ToolName) {
        if let Some(running) = lock(&self.tools().downloads).get(&tool) {
            running.cancel.cancel();
        }
    }

    async fn run_download(
        &self,
        tool: ToolName,
        cancel: CancellationToken,
    ) -> CoreResult<ToolStatus> {
        let mut progress = Progress {
            core: self.clone(),
            tool,
            received: 0,
            total: None,
            gate: ProgressGate::new(PROGRESS_EVERY),
        };
        let installed = self.install_tool(tool, &cancel, &mut progress).await;
        // Off the list before anyone hears the end, so a status read then is current.
        lock(&self.tools().downloads).remove(&tool);
        match installed {
            Ok(()) => {
                progress.send(ToolPhase::Done, None);
                Ok(self.tool_status(tool).await)
            }
            Err(error) => {
                progress.send(ToolPhase::Failed, Some(error.clone()));
                Err(error)
            }
        }
    }

    async fn install_tool(
        &self,
        tool: ToolName,
        cancel: &CancellationToken,
        progress: &mut Progress,
    ) -> CoreResult<()> {
        let tools = self.tools();
        let config = tools.config();
        let name = tool.as_str();
        let entry = tools.pinned(tool).ok_or_else(|| {
            let (os, arch) = current_platform().unwrap_or(("this OS", "this architecture"));
            IpcError::new(
                ErrorCode::InvalidInput,
                format!("there is no managed download of {name} for {os} {arch}"),
            )
        })?;
        let binary = tools.managed_path(&entry);
        // A copy already in place is kept while it runs and reports the pinned version.
        if is_executable(&binary)
            && tools
                .version(tool, &binary, cancel)
                .await
                .is_ok_and(|version| version == entry.version)
        {
            return Ok(());
        }
        let dir = tools.root.join(name);
        tokio::fs::create_dir_all(&dir).await?;
        let proxy = self.prefs_get().http_proxy;
        let client = download::client(proxy.as_deref(), &config.limits, config.https_only)?;
        let fetched = download::fetch(
            &client,
            &entry,
            &dir,
            &config.limits,
            cancel,
            &mut |received, total| progress.downloading(received, total),
        )
        .await?;
        progress.received = fetched.received;
        progress.send(ToolPhase::Verifying, None);
        if fetched.sha256 != entry.sha256.to_ascii_lowercase() {
            return Err(IpcError::new(
                ErrorCode::Internal,
                download::CHECKSUM_MISMATCH,
            ));
        }
        progress.send(ToolPhase::Extracting, None);
        let staging = tempfile::Builder::new()
            .prefix(".staging-")
            .tempdir_in(&dir)?;
        let staged = staging.path().join(tool.binary());
        let (target, wanted, max_bytes) = (staged.clone(), entry.clone(), config.limits.max_bytes);
        tokio::task::spawn_blocking(move || {
            let extracted = download::extract(fetched.file.path(), &wanted, &target, max_bytes);
            // Deletes the download.
            drop(fetched);
            extracted
        })
        .await
        .map_err(|error| {
            IpcError::new(
                ErrorCode::Internal,
                format!("the extraction stopped: {error}"),
            )
        })??;
        if cancel.is_cancelled() {
            return Err(download::cancelled());
        }
        // The version check runs once, on the copy about to be put in place.
        let version = read_version(tool, &staged, cancel)
            .await
            .map_err(|problem| {
                if cancel.is_cancelled() {
                    download::cancelled()
                } else {
                    IpcError::new(
                        ErrorCode::Internal,
                        format!("the downloaded {name} does not run: {problem}"),
                    )
                }
            })?;
        if version != entry.version {
            return Err(IpcError::new(
                ErrorCode::Internal,
                format!(
                    "the downloaded {name} reports {version}, not {}",
                    entry.version
                ),
            ));
        }
        let version_dir = dir.join(&entry.version);
        if version_dir.exists() {
            std::fs::remove_dir_all(&version_dir)?;
        }
        let kept = staging.keep();
        if let Err(error) = std::fs::rename(&kept, &version_dir) {
            let _ = std::fs::remove_dir_all(&kept);
            return Err(error.into());
        }
        tools.remember_version(&binary, version);
        remove_other_entries(&dir, &entry.version);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn make_executable(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[cfg(not(unix))]
    fn make_executable(_path: &Path) {}

    /// An empty file the lookup takes for a program.
    fn program(folder: &Path, name: &str) -> PathBuf {
        std::fs::create_dir_all(folder).unwrap();
        let path = folder.join(name);
        std::fs::write(&path, "").unwrap();
        make_executable(&path);
        path
    }

    #[test]
    fn preferences_come_before_path_and_path_before_the_managed_copy() {
        let dir = tempfile::tempdir().unwrap();
        let binary = ToolName::Helm.binary();
        let chosen = program(&dir.path().join("chosen"), &binary);
        let bin = dir.path().join("bin");
        let on_path = program(&bin, &binary);
        let managed = program(&dir.path().join("managed"), &binary);
        let search = Some(bin.as_os_str());

        let found = locate(ToolName::Helm, chosen.to_str(), search, Some(&managed));
        assert_eq!(
            found,
            Located {
                source: ToolSource::Preferences,
                path: Some(chosen),
                problem: None
            }
        );
        let found = locate(ToolName::Helm, None, search, Some(&managed));
        assert_eq!(
            found,
            Located {
                source: ToolSource::Path,
                path: Some(on_path),
                problem: None
            }
        );
        let found = locate(ToolName::Helm, None, Some(OsStr::new("")), Some(&managed));
        assert_eq!(
            found,
            Located {
                source: ToolSource::Managed,
                path: Some(managed),
                problem: None
            }
        );
        let found = locate(ToolName::Helm, None, None, None);
        assert_eq!(
            found,
            Located {
                source: ToolSource::Missing,
                path: None,
                problem: None
            }
        );
    }

    #[test]
    fn an_unusable_preferences_path_is_a_problem_and_ends_the_lookup() {
        let dir = tempfile::tempdir().unwrap();
        program(dir.path(), &ToolName::Helm.binary());
        let search = Some(dir.path().as_os_str());
        let missing = dir.path().join("missing").to_string_lossy().into_owned();
        let folder = dir.path().to_string_lossy().into_owned();
        let cases = [
            ("relative/helm".to_owned(), "is not an absolute path"),
            (missing, "does not exist"),
            (folder, "is not an executable file"),
        ];
        for (configured, why) in cases {
            let found = locate(ToolName::Helm, Some(&configured), search, None);
            assert_eq!(found.source, ToolSource::Preferences, "{configured}");
            assert_eq!(found.path, Some(PathBuf::from(&configured)));
            let problem = found.problem.unwrap_or_default();
            assert!(problem.contains(why), "{configured}: {problem}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_file_without_an_execute_bit_is_not_a_program() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("helm");
        std::fs::write(&path, "").unwrap();
        assert!(!is_executable(&path));
        let found = locate(ToolName::Helm, path.to_str(), None, None);
        assert!(found
            .problem
            .unwrap_or_default()
            .contains("is not an executable file"));
        let found = locate(ToolName::Helm, None, Some(dir.path().as_os_str()), None);
        assert_eq!(found.source, ToolSource::Missing);
    }

    /// Unix only: on Windows the temp folder can be on another drive than the working one.
    #[cfg(unix)]
    #[test]
    fn a_relative_path_entry_is_skipped() {
        let dir = tempfile::tempdir().unwrap();
        program(dir.path(), "helm");
        let cwd = std::env::current_dir().unwrap();
        let up = "../".repeat(cwd.components().count() - 1);
        let relative = format!("{up}{}", dir.path().strip_prefix("/").unwrap().display());
        assert!(
            Path::new(&relative).join("helm").is_file(),
            "the entry reaches the folder"
        );
        let found = locate(ToolName::Helm, None, Some(OsStr::new(&relative)), None);
        assert_eq!(found.source, ToolSource::Missing);
    }

    #[test]
    fn versions_are_read_from_each_tools_output() {
        assert_eq!(
            parse_version(ToolName::Helm, b"v4.3.1").as_deref(),
            Some("v4.3.1")
        );
        assert_eq!(
            parse_version(ToolName::Helm, b"v3.22.1\n").as_deref(),
            Some("v3.22.1")
        );
        assert_eq!(parse_version(ToolName::Helm, b""), None);
        assert_eq!(parse_version(ToolName::Helm, b"Error: unknown flag"), None);
        assert_eq!(
            parse_version(ToolName::Helm, b"version.BuildInfo{Version:\"v3.1\"}"),
            None
        );
        let kubectl = br#"{"clientVersion":{"major":"1","minor":"37","gitVersion":"v1.37.2"},"kustomizeVersion":"v5.7.1"}"#;
        assert_eq!(
            parse_version(ToolName::Kubectl, kubectl).as_deref(),
            Some("v1.37.2")
        );
        assert_eq!(parse_version(ToolName::Kubectl, b"v1.37.2"), None);
    }

    #[test]
    fn a_proxy_sets_both_variables() {
        assert!(proxy_env(None).is_empty());
        let proxy = OsString::from("http://proxy.example:3128");
        let expected = vec![
            (OsString::from("HTTPS_PROXY"), proxy.clone()),
            (OsString::from("HTTP_PROXY"), proxy),
        ];
        assert_eq!(proxy_env(Some("http://proxy.example:3128")), expected);
    }

    #[test]
    fn managed_folders_go_at_the_end_of_path_once() {
        let dir = tempfile::tempdir().unwrap();
        let [a, b, managed] = ["a", "b", "managed"].map(|name| dir.path().join(name));
        let current = std::env::join_paths([&a, &b]).unwrap();
        let split = |path: OsString| std::env::split_paths(&path).collect::<Vec<_>>();

        let current = Some(current.as_os_str());
        let joined = append_to_path(current, &[managed.clone(), a.clone()]).unwrap();
        assert_eq!(split(joined), [a.clone(), b.clone(), managed.clone()]);
        assert_eq!(append_to_path(current, std::slice::from_ref(&a)), None);
        assert_eq!(append_to_path(current, &[]), None);
        assert_eq!(
            split(append_to_path(None, std::slice::from_ref(&managed)).unwrap()),
            vec![managed.clone()]
        );
        // An empty entry would mean the working directory.
        let from_empty =
            append_to_path(Some(OsStr::new("")), std::slice::from_ref(&managed)).unwrap();
        assert_eq!(split(from_empty), [managed]);
    }
}
