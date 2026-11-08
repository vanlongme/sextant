//! The managed downloads (F14). Each SHA-256 value was copied on 2026-11-09 from the
//! `.sha256` file published beside the download, at the URL in its comment.

use super::ToolName;

pub const HELM_VERSION: &str = "v4.3.1";
pub const KUBECTL_VERSION: &str = "v1.37.2";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveFormat {
    TarGz,
    Zip,
    /// The download is the binary itself.
    Bare,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PinnedDownload {
    pub tool: ToolName,
    pub version: String,
    /// `linux`, `darwin` or `windows`.
    pub os: String,
    /// `amd64` or `arm64`.
    pub arch: String,
    pub url: String,
    /// Lowercase hex.
    pub sha256: String,
    pub format: ArchiveFormat,
    /// The archive entry that holds the binary. `None` for a bare download.
    pub entry: Option<String>,
}

const HELM_SHA256: [(&str, &str, &str); 6] = [
    // https://get.helm.sh/helm-v4.3.1-linux-amd64.tar.gz.sha256
    (
        "linux",
        "amd64",
        "0403a88ae20913d11b10a2467b50087721fea7581736da6b9d3992f5357fe54b",
    ),
    // https://get.helm.sh/helm-v4.3.1-linux-arm64.tar.gz.sha256
    (
        "linux",
        "arm64",
        "8cf8f66ecbc252ac8f7f06cca68aba88508ddfde3a6a34feb1678ad1694b4f88",
    ),
    // https://get.helm.sh/helm-v4.3.1-darwin-amd64.tar.gz.sha256
    (
        "darwin",
        "amd64",
        "34bec4eba761ba5c16d1965ee6b8f5b0abe5993974a802274e2a4f0418893d89",
    ),
    // https://get.helm.sh/helm-v4.3.1-darwin-arm64.tar.gz.sha256
    (
        "darwin",
        "arm64",
        "6b4e61c8cd27d99e5a801e63ff25dd5c70b36875c2cd659d3e9ce6b76fc23198",
    ),
    // https://get.helm.sh/helm-v4.3.1-windows-amd64.zip.sha256
    (
        "windows",
        "amd64",
        "fcfd7b796dcf0f225abc40b5636a3b01f55f3de2fb1dfb18475df94e62c14112",
    ),
    // https://get.helm.sh/helm-v4.3.1-windows-arm64.zip.sha256
    (
        "windows",
        "arm64",
        "373edaae86db70342ef39b014e2e7764ea8f9cff08714843daa5e55b5ee492f2",
    ),
];

const KUBECTL_SHA256: [(&str, &str, &str); 6] = [
    // https://dl.k8s.io/release/v1.37.2/bin/linux/amd64/kubectl.sha256
    (
        "linux",
        "amd64",
        "c04487523e7aa7d1493f7808174c899db93d7a9cf57531420cd76b9bd415f8f4",
    ),
    // https://dl.k8s.io/release/v1.37.2/bin/linux/arm64/kubectl.sha256
    (
        "linux",
        "arm64",
        "fcc16f63186659d9722014b7e02d5fdd2d4e669cb8c0ab66365d7d3b8ba03509",
    ),
    // https://dl.k8s.io/release/v1.37.2/bin/darwin/amd64/kubectl.sha256
    (
        "darwin",
        "amd64",
        "88379aff5c8111de6be0a394adffba2819e44cde269f3ab23cef76de1a48eaa8",
    ),
    // https://dl.k8s.io/release/v1.37.2/bin/darwin/arm64/kubectl.sha256
    (
        "darwin",
        "arm64",
        "55701af0d51815ee335f240e48acf0959c3c23017ed3fa816e880c4a92bae581",
    ),
    // https://dl.k8s.io/release/v1.37.2/bin/windows/amd64/kubectl.exe.sha256
    (
        "windows",
        "amd64",
        "1691938f7de0e931969f9968c3601cf32d6b0d573573afb4ce471f3d28f51984",
    ),
    // https://dl.k8s.io/release/v1.37.2/bin/windows/arm64/kubectl.exe.sha256
    (
        "windows",
        "arm64",
        "0f5965e47e4d864cf3409d8a744560b335a7c8244d0cab25e5bbba38738ef9ae",
    ),
];

/// Every pinned download, for every platform.
pub fn pinned_downloads() -> Vec<PinnedDownload> {
    let helm = HELM_SHA256.iter().map(|&(os, arch, sha256)| {
        let windows = os == "windows";
        let (extension, format, binary) = if windows {
            ("zip", ArchiveFormat::Zip, "helm.exe")
        } else {
            ("tar.gz", ArchiveFormat::TarGz, "helm")
        };
        PinnedDownload {
            tool: ToolName::Helm,
            version: HELM_VERSION.to_owned(),
            os: os.to_owned(),
            arch: arch.to_owned(),
            url: format!("https://get.helm.sh/helm-{HELM_VERSION}-{os}-{arch}.{extension}"),
            sha256: sha256.to_owned(),
            format,
            entry: Some(format!("{os}-{arch}/{binary}")),
        }
    });
    let kubectl = KUBECTL_SHA256.iter().map(|&(os, arch, sha256)| {
        let binary = if os == "windows" {
            "kubectl.exe"
        } else {
            "kubectl"
        };
        PinnedDownload {
            tool: ToolName::Kubectl,
            version: KUBECTL_VERSION.to_owned(),
            os: os.to_owned(),
            arch: arch.to_owned(),
            url: format!("https://dl.k8s.io/release/{KUBECTL_VERSION}/bin/{os}/{arch}/{binary}"),
            sha256: sha256.to_owned(),
            format: ArchiveFormat::Bare,
            entry: None,
        }
    });
    helm.chain(kubectl).collect()
}

/// This build's OS and architecture in the names the downloads use, if it has downloads.
pub fn current_platform() -> Option<(&'static str, &'static str)> {
    let os = match std::env::consts::OS {
        "linux" => "linux",
        "macos" => "darwin",
        "windows" => "windows",
        _ => return None,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        _ => return None,
    };
    Some((os, arch))
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    fn find(tool: ToolName, os: &str, arch: &str) -> PinnedDownload {
        pinned_downloads()
            .into_iter()
            .find(|entry| entry.tool == tool && entry.os == os && entry.arch == arch)
            .unwrap()
    }

    #[test]
    fn one_download_per_tool_os_and_architecture() {
        let all = pinned_downloads();
        assert_eq!(all.len(), 12);
        let mut seen = HashSet::new();
        for entry in &all {
            assert!(
                seen.insert((entry.tool, entry.os.clone(), entry.arch.clone())),
                "{entry:?}"
            );
            assert!(entry.url.starts_with("https://"), "{entry:?}");
            assert_eq!(entry.sha256.len(), 64, "{entry:?}");
            assert!(entry
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
        }
        for tool in ToolName::ALL {
            for os in ["linux", "darwin", "windows"] {
                for arch in ["amd64", "arm64"] {
                    assert!(
                        seen.contains(&(tool, os.to_owned(), arch.to_owned())),
                        "{tool:?} {os} {arch}"
                    );
                }
            }
        }
    }

    #[test]
    fn urls_and_entries_follow_the_official_layout() {
        let helm = find(ToolName::Helm, "linux", "amd64");
        assert_eq!(
            helm.url,
            "https://get.helm.sh/helm-v4.3.1-linux-amd64.tar.gz"
        );
        assert_eq!(helm.format, ArchiveFormat::TarGz);
        assert_eq!(helm.entry.as_deref(), Some("linux-amd64/helm"));
        assert_eq!(
            helm.sha256,
            "0403a88ae20913d11b10a2467b50087721fea7581736da6b9d3992f5357fe54b"
        );

        let helm = find(ToolName::Helm, "windows", "arm64");
        assert_eq!(
            helm.url,
            "https://get.helm.sh/helm-v4.3.1-windows-arm64.zip"
        );
        assert_eq!(helm.format, ArchiveFormat::Zip);
        assert_eq!(helm.entry.as_deref(), Some("windows-arm64/helm.exe"));

        let kubectl = find(ToolName::Kubectl, "darwin", "arm64");
        assert_eq!(
            kubectl.url,
            "https://dl.k8s.io/release/v1.37.2/bin/darwin/arm64/kubectl"
        );
        assert_eq!((kubectl.format, kubectl.entry), (ArchiveFormat::Bare, None));
        assert_eq!(
            kubectl.sha256,
            "55701af0d51815ee335f240e48acf0959c3c23017ed3fa816e880c4a92bae581"
        );

        let kubectl = find(ToolName::Kubectl, "windows", "amd64");
        assert_eq!(
            kubectl.url,
            "https://dl.k8s.io/release/v1.37.2/bin/windows/amd64/kubectl.exe"
        );
    }

    #[cfg(all(
        any(target_os = "linux", target_os = "macos", target_os = "windows"),
        any(target_arch = "x86_64", target_arch = "aarch64")
    ))]
    #[test]
    fn this_platform_has_downloads() {
        let (os, arch) = current_platform().unwrap();
        assert!(pinned_downloads()
            .iter()
            .any(|entry| entry.os == os && entry.arch == arch));
    }
}
