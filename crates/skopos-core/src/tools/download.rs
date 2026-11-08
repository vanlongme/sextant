//! Managed downloads (F14): HTTPS from the official hosts, hashed as the bytes arrive,
//! checked against the pinned SHA-256, and one archive entry taken out.

use std::fs::File;
use std::io::Read;
use std::path::{Component, Path};
use std::time::{Duration, Instant};

use flate2::read::GzDecoder;
use futures::StreamExt;
use sha2::{Digest, Sha256};
use tempfile::NamedTempFile;
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;
use url::Url;

use super::pinned::{ArchiveFormat, PinnedDownload};
use crate::error::{error_chain, CoreResult, ErrorCode, IpcError};

/// The fixed message of a checksum mismatch (IPC contract §2).
pub const CHECKSUM_MISMATCH: &str =
    "the downloaded file does not match its pinned SHA-256 checksum";
const MAX_REDIRECTS: usize = 10;
const MEBIBYTE: u64 = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DownloadLimits {
    pub connect: Duration,
    /// The longest wait for the response, and between two parts of the body.
    pub stall: Duration,
    /// For the download, and for the binary taken out of it.
    pub max_bytes: u64,
}

impl Default for DownloadLimits {
    fn default() -> Self {
        DownloadLimits {
            connect: Duration::from_secs(30),
            stall: Duration::from_secs(60),
            max_bytes: 200 * MEBIBYTE,
        }
    }
}

/// `path`, split into plain names, is exactly `wanted`'s `/`-separated names. A `..`, a
/// root or a drive never matches.
pub(crate) fn entry_matches(path: &Path, wanted: &str) -> bool {
    let mut components = path.components();
    wanted
        .split('/')
        .all(|name| matches!(components.next(), Some(Component::Normal(part)) if part == name))
        && components.next().is_none()
}

fn unreadable(error: impl std::fmt::Display) -> IpcError {
    IpcError::new(
        ErrorCode::Internal,
        format!("the downloaded archive could not be read: {error}"),
    )
}

fn missing_entry(wanted: &str) -> IpcError {
    IpcError::new(
        ErrorCode::Internal,
        format!("the downloaded archive has no {wanted}"),
    )
}

fn wanted_entry(entry: &PinnedDownload) -> CoreResult<&str> {
    entry.entry.as_deref().ok_or_else(|| {
        IpcError::new(
            ErrorCode::Internal,
            "the pinned download names no archive entry",
        )
    })
}

fn copy_capped(reader: &mut impl Read, binary: &Path, max_bytes: u64) -> CoreResult<()> {
    let mut file = File::create_new(binary)?;
    let copied = std::io::copy(&mut Read::take(reader, max_bytes + 1), &mut file)?;
    if copied > max_bytes {
        return Err(IpcError::new(
            ErrorCode::Internal,
            format!(
                "the binary in the download is larger than {} MB",
                max_bytes.div_ceil(MEBIBYTE)
            ),
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn make_executable(path: &Path) -> CoreResult<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))?;
    Ok(())
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> CoreResult<()> {
    Ok(())
}

/// Writes the binary to `binary`, which must not exist yet. Only the archive entry named by
/// `entry.entry`, as a regular file, is taken; nothing else in the archive is written.
pub(crate) fn extract(
    download: &Path,
    entry: &PinnedDownload,
    binary: &Path,
    max_bytes: u64,
) -> CoreResult<()> {
    match entry.format {
        ArchiveFormat::Bare => copy_capped(&mut File::open(download)?, binary, max_bytes)?,
        ArchiveFormat::TarGz => {
            let wanted = wanted_entry(entry)?;
            let mut archive = tar::Archive::new(GzDecoder::new(File::open(download)?));
            let mut found = false;
            for item in archive.entries().map_err(unreadable)? {
                let mut item = item.map_err(unreadable)?;
                let path = item.path().map_err(unreadable)?.into_owned();
                if item.header().entry_type().is_file() && entry_matches(&path, wanted) {
                    copy_capped(&mut item, binary, max_bytes)?;
                    found = true;
                    break;
                }
            }
            if !found {
                return Err(missing_entry(wanted));
            }
        }
        ArchiveFormat::Zip => {
            let wanted = wanted_entry(entry)?;
            let mut archive = zip::ZipArchive::new(File::open(download)?).map_err(unreadable)?;
            let mut found = false;
            for index in 0..archive.len() {
                let mut item = archive.by_index(index).map_err(unreadable)?;
                // `enclosed_name` is `None` for a path that is absolute or leaves the folder.
                let named = item
                    .enclosed_name()
                    .is_some_and(|path| entry_matches(&path, wanted));
                if item.is_file() && named {
                    copy_capped(&mut item, binary, max_bytes)?;
                    found = true;
                    break;
                }
            }
            if !found {
                return Err(missing_entry(wanted));
            }
        }
    }
    make_executable(binary)
}

/// Only HTTPS, unless a test allows plain HTTP.
pub(crate) fn redirect_allowed(url: &Url, https_only: bool) -> bool {
    !https_only || url.scheme() == "https"
}

/// A temp file beside the managed copies. Unix gives it mode 0600.
pub(crate) fn temp_download(dir: &Path) -> std::io::Result<NamedTempFile> {
    tempfile::Builder::new()
        .prefix(".download-")
        .tempfile_in(dir)
}

impl ProgressGate {
    pub(crate) fn ready(&mut self, now: Instant) -> bool {
        if self
            .last
            .is_some_and(|last| now.duration_since(last) < self.every)
        {
            return false;
        }
        self.last = Some(now);
        true
    }
}

pub(crate) fn cancelled() -> IpcError {
    IpcError::new(ErrorCode::Cancelled, "the download was cancelled")
}

fn too_large(limits: &DownloadLimits) -> IpcError {
    IpcError::new(
        ErrorCode::Internal,
        format!(
            "the download is larger than {} MB",
            limits.max_bytes.div_ceil(MEBIBYTE)
        ),
    )
}

fn stalled(limits: &DownloadLimits) -> IpcError {
    IpcError::new(
        ErrorCode::Unreachable,
        format!(
            "the download stalled: nothing arrived for {} s",
            limits.stall.as_secs()
        ),
    )
}

fn request_error(error: reqwest::Error) -> IpcError {
    let code = if error.is_builder() || error.is_redirect() {
        ErrorCode::Internal
    } else {
        ErrorCode::Unreachable
    };
    IpcError::new(code, format!("the download failed: {error}")).with_details(error_chain(&error))
}

/// `proxy` is `Prefs.httpProxy`; without one, reqwest uses the system proxy.
pub(crate) fn client(
    proxy: Option<&str>,
    limits: &DownloadLimits,
    https_only: bool,
) -> CoreResult<reqwest::Client> {
    // reqwest has no TLS crypto provider of its own here, so it takes the process default.
    // kube uses ring; a second provider would make every kube connection panic.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let policy = reqwest::redirect::Policy::custom(move |attempt| {
        if !redirect_allowed(attempt.url(), https_only) {
            attempt.error("a download may only be redirected to HTTPS")
        } else if attempt.previous().len() >= MAX_REDIRECTS {
            attempt.error("the download was redirected too many times")
        } else {
            attempt.follow()
        }
    });
    let mut builder = reqwest::Client::builder()
        .connect_timeout(limits.connect)
        .https_only(https_only)
        .redirect(policy);
    if let Some(proxy) = proxy {
        let proxy = reqwest::Proxy::all(proxy).map_err(|error| {
            IpcError::new(
                ErrorCode::InvalidInput,
                "the HTTP proxy in Preferences is not a valid URL",
            )
            .with_details(error.to_string())
        })?;
        builder = builder.proxy(proxy);
    }
    builder.build().map_err(|error| {
        IpcError::new(
            ErrorCode::Internal,
            format!("the download could not start: {error}"),
        )
    })
}

/// A finished download, still in its temp file, which is deleted when this is dropped.
pub(crate) struct Fetched {
    pub(crate) file: NamedTempFile,
    pub(crate) sha256: String,
    pub(crate) received: u64,
}

/// Streams `entry.url` into a temp file in `dir`, hashing as it goes. `on_progress` gets the
/// bytes received so far and the size the server announced.
pub(crate) async fn fetch(
    client: &reqwest::Client,
    entry: &PinnedDownload,
    dir: &Path,
    limits: &DownloadLimits,
    cancel: &CancellationToken,
    on_progress: &mut (dyn FnMut(u64, Option<u64>) + Send),
) -> CoreResult<Fetched> {
    let response = tokio::select! {
        biased;
        () = cancel.cancelled() => return Err(cancelled()),
        sent = tokio::time::timeout(limits.stall, client.get(&entry.url).send()) => match sent {
            Err(_) => return Err(stalled(limits)),
            Ok(sent) => sent.map_err(request_error)?,
        },
    };
    let status = response.status();
    if !status.is_success() {
        let code = if status.is_server_error() {
            ErrorCode::Unreachable
        } else {
            ErrorCode::Internal
        };
        return Err(
            IpcError::new(code, format!("the download server answered {status}"))
                .with_details(entry.url.clone()),
        );
    }
    let total = response.content_length();
    if total.is_some_and(|total| total > limits.max_bytes) {
        return Err(too_large(limits));
    }
    let file = temp_download(dir)?;
    let mut writer = tokio::fs::File::from_std(file.reopen()?);
    let mut hasher = Sha256::new();
    let mut received = 0u64;
    let mut body = response.bytes_stream();
    on_progress(0, total);
    loop {
        let next = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(cancelled()),
            next = tokio::time::timeout(limits.stall, body.next()) => next,
        };
        let chunk = match next {
            Err(_) => return Err(stalled(limits)),
            Ok(None) => break,
            Ok(Some(chunk)) => chunk.map_err(request_error)?,
        };
        received += chunk.len() as u64;
        if received > limits.max_bytes {
            return Err(too_large(limits));
        }
        hasher.update(&chunk);
        writer.write_all(&chunk).await?;
        on_progress(received, total);
    }
    writer.flush().await?;
    drop(writer);
    let sha256 = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok(Fetched {
        file,
        sha256,
        received,
    })
}

/// Lets a progress event through at most once per `every`.
pub(crate) struct ProgressGate {
    every: Duration,
    last: Option<Instant>,
}

impl ProgressGate {
    pub(crate) fn new(every: Duration) -> Self {
        ProgressGate { every, last: None }
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Write};

    use super::*;
    use crate::tools::ToolName;

    const WANTED: &str = "linux-amd64/helm";
    const LIMIT: u64 = MEBIBYTE;

    fn entry(format: ArchiveFormat, wanted: Option<&str>) -> PinnedDownload {
        PinnedDownload {
            tool: ToolName::Helm,
            version: "v9.9.9".into(),
            os: "linux".into(),
            arch: "amd64".into(),
            url: "https://example.invalid/helm".into(),
            sha256: String::new(),
            format,
            entry: wanted.map(str::to_owned),
        }
    }

    /// Entry names go in as they are, `..` and a leading `/` included.
    fn tar_gz(entries: &[(&str, tar::EntryType, &[u8])]) -> Vec<u8> {
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        {
            let mut builder = tar::Builder::new(&mut gz);
            for (name, kind, data) in entries {
                let mut header = tar::Header::new_old();
                header.as_old_mut().name[..name.len()].copy_from_slice(name.as_bytes());
                header.set_entry_type(*kind);
                header.set_mode(0o755);
                header.set_size(data.len() as u64);
                header.set_cksum();
                builder.append(&header, *data).unwrap();
            }
            builder.finish().unwrap();
        }
        gz.finish().unwrap()
    }

    fn write_temp(bytes: &[u8]) -> NamedTempFile {
        let mut file = NamedTempFile::new().unwrap();
        file.write_all(bytes).unwrap();
        file
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|item| item.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    /// A temp folder with an empty `staging` folder in it.
    fn staging() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("staging");
        std::fs::create_dir(&out).unwrap();
        (dir, out)
    }

    #[cfg(unix)]
    fn mode(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn entry_names_match_exactly() {
        assert!(entry_matches(Path::new("linux-amd64/helm"), WANTED));
        assert!(!entry_matches(Path::new("linux-amd64/helm/more"), WANTED));
        assert!(!entry_matches(Path::new("helm"), WANTED));
        assert!(!entry_matches(Path::new("../linux-amd64/helm"), WANTED));
        assert!(!entry_matches(Path::new("/linux-amd64/helm"), WANTED));
        assert!(!entry_matches(
            Path::new("linux-amd64/../linux-amd64/helm"),
            WANTED
        ));
        assert!(!entry_matches(Path::new("linux-arm64/helm"), WANTED));
    }

    #[test]
    fn only_the_named_entry_is_taken_from_a_tar_gz() {
        use tar::EntryType::Regular;
        let archive = write_temp(&tar_gz(&[
            ("linux-amd64/README.md", Regular, b"read me"),
            ("../escape", Regular, b"outside"),
            ("/linux-amd64/helm", Regular, b"absolute"),
            ("linux-amd64/../linux-amd64/helm", Regular, b"dotted"),
            ("linux-amd64/helm", Regular, b"the binary"),
        ]));
        let (dir, out) = staging();
        let binary = out.join("helm");
        extract(
            archive.path(),
            &entry(ArchiveFormat::TarGz, Some(WANTED)),
            &binary,
            LIMIT,
        )
        .unwrap();
        assert_eq!(std::fs::read(&binary).unwrap(), b"the binary");
        assert_eq!(names(&out), ["helm"]);
        assert_eq!(names(dir.path()), ["staging"]);
        #[cfg(unix)]
        assert_eq!(mode(&binary), 0o755);
    }

    #[test]
    fn a_symlink_with_the_name_is_not_the_binary() {
        let archive = write_temp(&tar_gz(&[(WANTED, tar::EntryType::Symlink, b"")]));
        let (_dir, out) = staging();
        let binary = out.join("helm");
        let error = extract(
            archive.path(),
            &entry(ArchiveFormat::TarGz, Some(WANTED)),
            &binary,
            LIMIT,
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::Internal);
        assert!(
            error.message.contains("has no linux-amd64/helm"),
            "{error:?}"
        );
        assert!(!binary.exists());
    }

    #[test]
    fn a_binary_past_the_size_limit_is_refused() {
        let big = vec![0u8; 2048];
        let archive = write_temp(&tar_gz(&[(WANTED, tar::EntryType::Regular, &big)]));
        let (_dir, out) = staging();
        let error = extract(
            archive.path(),
            &entry(ArchiveFormat::TarGz, Some(WANTED)),
            &out.join("helm"),
            1024,
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::Internal);
        assert!(error.message.contains("larger than"), "{error:?}");
    }

    #[test]
    fn only_the_named_entry_is_taken_from_a_zip() {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let files: [(&str, &[u8]); 3] = [
            ("../windows-amd64/helm.exe", b"outside"),
            ("windows-amd64/LICENSE", b"license"),
            ("windows-amd64/helm.exe", b"the binary"),
        ];
        for (name, data) in files {
            writer.start_file(name, options).unwrap();
            writer.write_all(data).unwrap();
        }
        let archive = write_temp(&writer.finish().unwrap().into_inner());
        let (dir, out) = staging();
        let binary = out.join("helm.exe");
        let zip_entry = entry(ArchiveFormat::Zip, Some("windows-amd64/helm.exe"));
        extract(archive.path(), &zip_entry, &binary, LIMIT).unwrap();
        assert_eq!(std::fs::read(&binary).unwrap(), b"the binary");
        assert_eq!(names(&out), ["helm.exe"]);
        assert_eq!(names(dir.path()), ["staging"]);
    }

    #[test]
    fn a_bare_download_is_the_binary() {
        let download = write_temp(b"kubectl bytes");
        let (_dir, out) = staging();
        let binary = out.join("kubectl");
        extract(
            download.path(),
            &entry(ArchiveFormat::Bare, None),
            &binary,
            LIMIT,
        )
        .unwrap();
        assert_eq!(std::fs::read(&binary).unwrap(), b"kubectl bytes");
        #[cfg(unix)]
        assert_eq!(mode(&binary), 0o755);
    }

    #[test]
    fn redirects_must_stay_on_https() {
        let https = Url::parse("https://get.helm.sh/x").unwrap();
        let http = Url::parse("http://get.helm.sh/x").unwrap();
        assert!(redirect_allowed(&https, true));
        assert!(!redirect_allowed(&http, true));
        assert!(redirect_allowed(&http, false));
    }

    #[test]
    fn progress_passes_at_most_once_per_interval() {
        let start = Instant::now();
        let mut gate = ProgressGate::new(Duration::from_millis(200));
        assert!(gate.ready(start));
        assert!(!gate.ready(start + Duration::from_millis(100)));
        assert!(gate.ready(start + Duration::from_millis(200)));
        assert!(!gate.ready(start + Duration::from_millis(250)));
    }

    #[cfg(unix)]
    #[test]
    fn the_temp_file_is_private() {
        let dir = tempfile::tempdir().unwrap();
        let file = temp_download(dir.path()).unwrap();
        assert_eq!(mode(file.path()), 0o600);
        assert!(file
            .path()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with(".download-"));
    }
}
