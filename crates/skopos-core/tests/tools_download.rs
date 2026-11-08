//! Managed downloads from a local HTTP server, with a download table made for each test
//! (F14). The "binaries" are shell scripts, so this file runs on Unix.
#![cfg(unix)]

use std::ffi::OsString;
use std::net::SocketAddr;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::{Body, Bytes};
use axum::routing::{get, MethodRouter};
use axum::Router;
use futures::StreamExt;
use sha2::{Digest, Sha256};
use skopos_core::app_core::{AppCore, CoreEvent};
use skopos_core::error::ErrorCode;
use skopos_core::paths::AppPaths;
use skopos_core::prefs::Prefs;
use skopos_core::tools::download::{DownloadLimits, CHECKSUM_MISMATCH};
use skopos_core::tools::pinned::{current_platform, ArchiveFormat, PinnedDownload};
use skopos_core::tools::{ToolName, ToolPhase, ToolProgress, ToolSource, ToolsConfig};
use tempfile::TempDir;
use tokio::sync::{broadcast, Semaphore};

const LIMIT: Duration = Duration::from_secs(30);
const STALL: Duration = Duration::from_millis(500);

fn platform() -> (&'static str, &'static str) {
    current_platform().expect("the CI platforms have downloads")
}

fn helm_script(version: &str) -> Vec<u8> {
    format!("#!/bin/sh\nprintf {version}\n").into_bytes()
}

fn kubectl_script(version: &str) -> Vec<u8> {
    format!("#!/bin/sh\nprintf '{{\"clientVersion\":{{\"gitVersion\":\"{version}\"}}}}'\n")
        .into_bytes()
}

fn tar_gz(entries: &[(String, Vec<u8>)]) -> Vec<u8> {
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    {
        let mut builder = tar::Builder::new(&mut gz);
        for (name, data) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o755);
            header.set_entry_type(tar::EntryType::Regular);
            header.set_cksum();
            builder
                .append_data(&mut header, name, data.as_slice())
                .unwrap();
        }
        builder.finish().unwrap();
    }
    gz.finish().unwrap()
}

/// Laid out as the official archives: `<os>-<arch>/helm` beside other files.
fn helm_archive(version: &str) -> Vec<u8> {
    let (os, arch) = platform();
    tar_gz(&[
        (format!("{os}-{arch}/LICENSE"), b"license".to_vec()),
        (format!("{os}-{arch}/helm"), helm_script(version)),
    ])
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn helm_entry(url: String, archive: &[u8], version: &str) -> PinnedDownload {
    let (os, arch) = platform();
    PinnedDownload {
        tool: ToolName::Helm,
        version: version.into(),
        os: os.into(),
        arch: arch.into(),
        url,
        sha256: sha256_hex(archive),
        format: ArchiveFormat::TarGz,
        entry: Some(format!("{os}-{arch}/helm")),
    }
}

fn kubectl_entry(url: String, file: &[u8], version: &str) -> PinnedDownload {
    let (os, arch) = platform();
    PinnedDownload {
        tool: ToolName::Kubectl,
        version: version.into(),
        os: os.into(),
        arch: arch.into(),
        url,
        sha256: sha256_hex(file),
        format: ArchiveFormat::Bare,
        entry: None,
    }
}

/// Serves `body`, counting the requests.
fn file(body: Vec<u8>, requests: Arc<AtomicUsize>) -> MethodRouter {
    get(move || {
        let (body, requests) = (body.clone(), requests.clone());
        async move {
            requests.fetch_add(1, Ordering::SeqCst);
            body
        }
    })
}

/// Sends a little, then nothing more.
fn stalls() -> MethodRouter {
    get(|| async {
        let start = futures::stream::once(async {
            Ok::<_, std::io::Error>(Bytes::from_static(b"partial"))
        });
        Body::from_stream(start.chain(futures::stream::pending()))
    })
}

/// Accepts the request and never answers.
fn silent() -> MethodRouter {
    get(|| async {
        std::future::pending::<()>().await;
        "never"
    })
}

async fn serve(router: Router) -> SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    addr
}

struct Setup {
    core: AppCore,
    root: TempDir,
}

impl Setup {
    async fn new(downloads: Vec<PinnedDownload>) -> Setup {
        Setup::with_stall(downloads, STALL).await
    }

    async fn with_stall(downloads: Vec<PinnedDownload>, stall: Duration) -> Setup {
        let root = tempfile::tempdir().unwrap();
        let paths = AppPaths::under(&root.path().join("app"), &root.path().join("home"));
        let core = AppCore::start_with_kubeconfig_env(paths, None)
            .await
            .unwrap();
        core.set_tools_config_for_test(ToolsConfig {
            downloads,
            // An empty `PATH`, so the lookup finds the managed copy.
            search_path: Some(OsString::new()),
            limits: DownloadLimits {
                stall,
                ..DownloadLimits::default()
            },
            https_only: false,
        });
        Setup { core, root }
    }

    fn tool_dir(&self, tool: ToolName) -> PathBuf {
        self.root.path().join("app/data/tools").join(tool.as_str())
    }
}

fn names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .map(|read| {
            read.flatten()
                .map(|item| item.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

fn mode(path: &Path) -> u32 {
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

fn write_script(path: &Path, content: &[u8]) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, content).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

async fn wait_until(mut condition: impl FnMut() -> bool) {
    tokio::time::timeout(LIMIT, async {
        while !condition() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the condition never held");
}

/// Progress events until the download ends.
async fn progress_until_end(events: &mut broadcast::Receiver<CoreEvent>) -> Vec<ToolProgress> {
    let mut seen = Vec::new();
    tokio::time::timeout(LIMIT, async {
        loop {
            match events.recv().await {
                Ok(CoreEvent::ToolProgress { progress }) => {
                    let end = matches!(progress.phase, ToolPhase::Done | ToolPhase::Failed);
                    seen.push(progress);
                    if end {
                        return;
                    }
                }
                Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => panic!("the events stopped"),
            }
        }
    })
    .await
    .expect("the download never ended");
    seen
}

#[tokio::test]
async fn helm_is_downloaded_checked_and_put_in_place() {
    let archive = helm_archive("v9.9.9");
    let requests = Arc::new(AtomicUsize::new(0));
    let router = Router::new().route("/helm.tar.gz", file(archive.clone(), requests.clone()));
    let addr = serve(router).await;
    let url = format!("http://{addr}/helm.tar.gz");
    let setup = Setup::new(vec![helm_entry(url, &archive, "v9.9.9")]).await;
    let mut events = setup.core.subscribe();

    let status = setup.core.tools_download(ToolName::Helm).await.unwrap();

    let binary = setup.tool_dir(ToolName::Helm).join("v9.9.9/helm");
    assert_eq!(status.source, ToolSource::Managed);
    assert_eq!(status.path.as_deref(), binary.to_str());
    assert_eq!(status.version.as_deref(), Some("v9.9.9"));
    assert!(
        status.managed_installed && !status.downloading,
        "{status:?}"
    );
    assert_eq!(mode(&binary), 0o755);
    assert_eq!(names(&setup.tool_dir(ToolName::Helm)), ["v9.9.9"]);
    assert_eq!(names(binary.parent().unwrap()), ["helm"]);
    let progress = progress_until_end(&mut events).await;
    let phases: Vec<ToolPhase> = progress.iter().map(|event| event.phase).collect();
    assert_eq!(phases.first(), Some(&ToolPhase::Downloading));
    assert_eq!(
        phases[phases.len() - 3..],
        [ToolPhase::Verifying, ToolPhase::Extracting, ToolPhase::Done]
    );
    assert!(progress
        .windows(2)
        .all(|pair| pair[0].received_bytes <= pair[1].received_bytes));
    let done = progress.last().unwrap();
    let size = archive.len() as u64;
    assert_eq!((done.received_bytes, done.total_bytes), (size, Some(size)));
    assert_eq!(done.error, None);
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    setup.core.shutdown().await;
}

#[tokio::test]
async fn kubectl_is_the_downloaded_file_itself() {
    let script = kubectl_script("v9.9.8");
    let router = Router::new().route("/kubectl", file(script.clone(), Arc::default()));
    let addr = serve(router).await;
    let entry = kubectl_entry(format!("http://{addr}/kubectl"), &script, "v9.9.8");
    let setup = Setup::new(vec![entry]).await;

    let status = setup.core.tools_download(ToolName::Kubectl).await.unwrap();

    let binary = setup.tool_dir(ToolName::Kubectl).join("v9.9.8/kubectl");
    assert_eq!(status.version.as_deref(), Some("v9.9.8"));
    assert_eq!(std::fs::read(&binary).unwrap(), script);
    assert_eq!(mode(&binary), 0o755);
    setup.core.shutdown().await;
}

#[tokio::test]
async fn a_second_call_waits_for_the_running_download() {
    let archive = helm_archive("v9.9.9");
    let requests = Arc::new(AtomicUsize::new(0));
    let gate = Arc::new(Semaphore::new(0));
    let (body, counter, held) = (archive.clone(), requests.clone(), gate.clone());
    let route = get(move || {
        let (body, counter, held) = (body.clone(), counter.clone(), held.clone());
        async move {
            counter.fetch_add(1, Ordering::SeqCst);
            let _open = held.acquire().await.unwrap();
            body
        }
    });
    let addr = serve(Router::new().route("/helm.tar.gz", route)).await;
    let url = format!("http://{addr}/helm.tar.gz");
    let setup = Setup::with_stall(vec![helm_entry(url, &archive, "v9.9.9")], LIMIT).await;

    let core = setup.core.clone();
    let first = tokio::spawn(async move { core.tools_download(ToolName::Helm).await });
    wait_until(|| requests.load(Ordering::SeqCst) == 1).await;
    assert!(setup.core.tool_status(ToolName::Helm).await.downloading);
    let core = setup.core.clone();
    let second = tokio::spawn(async move { core.tools_download(ToolName::Helm).await });
    // Lets the second call start and join before the server answers.
    tokio::time::sleep(Duration::from_millis(100)).await;
    gate.add_permits(1);

    let first = first.await.unwrap().unwrap();
    let second = second.await.unwrap().unwrap();
    assert_eq!(first, second);
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    setup.core.shutdown().await;
}

#[tokio::test]
async fn a_checksum_mismatch_deletes_the_download() {
    let archive = helm_archive("v9.9.9");
    let router = Router::new().route("/helm.tar.gz", file(archive.clone(), Arc::default()));
    let addr = serve(router).await;
    let mut entry = helm_entry(format!("http://{addr}/helm.tar.gz"), &archive, "v9.9.9");
    entry.sha256 = sha256_hex(b"something else");
    let setup = Setup::new(vec![entry]).await;
    let mut events = setup.core.subscribe();

    let error = setup.core.tools_download(ToolName::Helm).await.unwrap_err();

    assert_eq!(
        (error.code, error.message.as_str()),
        (ErrorCode::Internal, CHECKSUM_MISMATCH)
    );
    assert!(names(&setup.tool_dir(ToolName::Helm)).is_empty());
    let failed = progress_until_end(&mut events).await.pop().unwrap();
    assert_eq!(failed.phase, ToolPhase::Failed);
    assert_eq!(failed.error, Some(error));
    setup.core.shutdown().await;
}

#[tokio::test]
async fn a_download_that_stalls_gives_up() {
    let addr = serve(Router::new().route("/helm.tar.gz", stalls())).await;
    let url = format!("http://{addr}/helm.tar.gz");
    let setup = Setup::new(vec![helm_entry(url, b"unused", "v9.9.9")]).await;
    let error = setup.core.tools_download(ToolName::Helm).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::Unreachable, "{error:?}");
    assert!(names(&setup.tool_dir(ToolName::Helm)).is_empty());
    setup.core.shutdown().await;
}

#[tokio::test]
async fn a_server_that_never_answers_gives_up() {
    let addr = serve(Router::new().route("/helm.tar.gz", silent())).await;
    let url = format!("http://{addr}/helm.tar.gz");
    let setup = Setup::new(vec![helm_entry(url, b"unused", "v9.9.9")]).await;
    let started = Instant::now();
    let error = setup.core.tools_download(ToolName::Helm).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::Unreachable, "{error:?}");
    assert!(started.elapsed() < Duration::from_secs(10));
    setup.core.shutdown().await;
}

#[tokio::test]
async fn cancelling_stops_the_download_and_deletes_the_partial_file() {
    let addr = serve(Router::new().route("/helm.tar.gz", stalls())).await;
    let url = format!("http://{addr}/helm.tar.gz");
    let setup = Setup::with_stall(vec![helm_entry(url, b"unused", "v9.9.9")], LIMIT).await;
    let dir = setup.tool_dir(ToolName::Helm);
    let core = setup.core.clone();
    let download = tokio::spawn(async move { core.tools_download(ToolName::Helm).await });
    wait_until(|| {
        names(&dir)
            .iter()
            .any(|name| name.starts_with(".download-"))
    })
    .await;

    setup.core.tools_download_cancel(ToolName::Helm);

    let error = download.await.unwrap().unwrap_err();
    assert_eq!(error.code, ErrorCode::Cancelled);
    assert!(names(&dir).is_empty(), "{:?}", names(&dir));
    assert!(!setup.core.tool_status(ToolName::Helm).await.downloading);
    setup.core.shutdown().await;
}

#[tokio::test]
async fn a_copy_already_in_place_is_not_downloaded_again() {
    let archive = helm_archive("v9.9.9");
    let requests = Arc::new(AtomicUsize::new(0));
    let router = Router::new().route("/helm.tar.gz", file(archive.clone(), requests.clone()));
    let addr = serve(router).await;
    let url = format!("http://{addr}/helm.tar.gz");
    let setup = Setup::new(vec![helm_entry(url, &archive, "v9.9.9")]).await;
    let first = setup.core.tools_download(ToolName::Helm).await.unwrap();
    let second = setup.core.tools_download(ToolName::Helm).await.unwrap();
    assert_eq!(first, second);
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    setup.core.shutdown().await;
}

#[tokio::test]
async fn a_managed_copy_that_reports_another_version_is_replaced() {
    let archive = helm_archive("v9.9.9");
    let requests = Arc::new(AtomicUsize::new(0));
    let router = Router::new().route("/helm.tar.gz", file(archive.clone(), requests.clone()));
    let addr = serve(router).await;
    let url = format!("http://{addr}/helm.tar.gz");
    let setup = Setup::new(vec![helm_entry(url, &archive, "v9.9.9")]).await;
    let binary = setup.tool_dir(ToolName::Helm).join("v9.9.9/helm");
    write_script(&binary, &helm_script("v0.0.1"));

    let status = setup.core.tools_download(ToolName::Helm).await.unwrap();

    assert_eq!(status.version.as_deref(), Some("v9.9.9"));
    assert_eq!(std::fs::read(&binary).unwrap(), helm_script("v9.9.9"));
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    setup.core.shutdown().await;
}

#[tokio::test]
async fn an_install_removes_other_versions_and_leftovers() {
    let archive = helm_archive("v9.9.9");
    let router = Router::new().route("/helm.tar.gz", file(archive.clone(), Arc::default()));
    let addr = serve(router).await;
    let url = format!("http://{addr}/helm.tar.gz");
    let setup = Setup::new(vec![helm_entry(url, &archive, "v9.9.9")]).await;
    let dir = setup.tool_dir(ToolName::Helm);
    write_script(&dir.join("v1.0.0/helm"), &helm_script("v1.0.0"));
    std::fs::write(dir.join(".download-left-by-a-crash"), b"partial").unwrap();

    setup.core.tools_download(ToolName::Helm).await.unwrap();

    assert_eq!(names(&dir), ["v9.9.9"]);
    setup.core.shutdown().await;
}

#[tokio::test]
async fn downloads_go_through_the_proxy_in_preferences() {
    let archive = helm_archive("v9.9.9");
    let requests = Arc::new(AtomicUsize::new(0));
    let router = Router::new().route("/helm.tar.gz", file(archive.clone(), requests.clone()));
    let proxy = serve(router).await;
    // Only the proxy can answer for this host.
    let url = "http://tools.invalid/helm.tar.gz".to_owned();
    let setup = Setup::new(vec![helm_entry(url, &archive, "v9.9.9")]).await;
    setup
        .core
        .prefs_set(Prefs {
            http_proxy: Some(format!("http://{proxy}")),
            ..setup.core.prefs_get()
        })
        .unwrap();

    let status = setup.core.tools_download(ToolName::Helm).await.unwrap();

    assert_eq!(status.version.as_deref(), Some("v9.9.9"));
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    setup.core.shutdown().await;
}

#[tokio::test]
async fn a_proxy_password_never_reaches_the_error() {
    let url = "http://tools.invalid/helm.tar.gz".to_owned();
    let setup = Setup::new(vec![helm_entry(url, b"unused", "v9.9.9")]).await;
    setup
        .core
        .prefs_set(Prefs {
            http_proxy: Some("http://user:topsecret@127.0.0.1:1".into()),
            ..setup.core.prefs_get()
        })
        .unwrap();

    let error = setup.core.tools_download(ToolName::Helm).await.unwrap_err();

    assert_eq!(error.code, ErrorCode::Unreachable, "{error:?}");
    assert!(!error.message.contains("topsecret"), "{error:?}");
    assert!(!error.details.unwrap_or_default().contains("topsecret"));
    setup.core.shutdown().await;
}

#[tokio::test]
async fn no_download_for_this_platform_is_invalid_input() {
    let setup = Setup::new(Vec::new()).await;
    let error = setup.core.tools_download(ToolName::Helm).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
    assert_eq!(
        setup.core.tool_status(ToolName::Helm).await.managed_version,
        None
    );
    setup.core.shutdown().await;
}

#[tokio::test]
async fn a_plain_http_url_is_refused_outside_tests() {
    let archive = helm_archive("v9.9.9");
    let requests = Arc::new(AtomicUsize::new(0));
    let router = Router::new().route("/helm.tar.gz", file(archive.clone(), requests.clone()));
    let addr = serve(router).await;
    let entry = helm_entry(format!("http://{addr}/helm.tar.gz"), &archive, "v9.9.9");
    let setup = Setup::new(Vec::new()).await;
    setup.core.set_tools_config_for_test(ToolsConfig {
        downloads: vec![entry],
        search_path: Some(OsString::new()),
        ..ToolsConfig::default()
    });

    let error = setup.core.tools_download(ToolName::Helm).await.unwrap_err();

    assert_eq!(error.code, ErrorCode::Internal, "{error:?}");
    assert_eq!(requests.load(Ordering::SeqCst), 0);
    setup.core.shutdown().await;
}

#[tokio::test]
async fn a_download_that_reports_another_version_is_not_put_in_place() {
    let archive = helm_archive("v0.0.1");
    let router = Router::new().route("/helm.tar.gz", file(archive.clone(), Arc::default()));
    let addr = serve(router).await;
    let url = format!("http://{addr}/helm.tar.gz");
    let setup = Setup::new(vec![helm_entry(url, &archive, "v9.9.9")]).await;

    let error = setup.core.tools_download(ToolName::Helm).await.unwrap_err();

    assert_eq!(error.code, ErrorCode::Internal);
    assert!(error.message.contains("reports v0.0.1"), "{error:?}");
    assert!(names(&setup.tool_dir(ToolName::Helm)).is_empty());
    setup.core.shutdown().await;
}
