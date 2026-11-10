//! What About shows (spec C §8.2). The app fills in the Tauri parts.

use serde::Serialize;
use ts_rs::TS;

use crate::tools::pinned::{HELM_VERSION, KUBECTL_VERSION};

/// Version facts for About and for Copy version info.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AppInfo {
    pub version: String,
    pub commit: Option<String>,
    pub commit_date: Option<String>,
    pub tauri: String,
    pub webview: String,
    pub webview_version: Option<String>,
    pub platform: String,
    pub helm: String,
    pub kubectl: String,
}

/// The webview the target OS uses.
pub fn webview_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "WKWebView"
    } else if cfg!(target_os = "windows") {
        "WebView2"
    } else {
        "WebKitGTK"
    }
}

pub fn platform_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "macOS"
    } else if cfg!(target_os = "windows") {
        "Windows"
    } else {
        "Linux"
    }
}

impl AppInfo {
    /// `build.rs` writes empty strings when git was not there; they become null.
    pub fn new(
        commit: &str,
        commit_date: &str,
        tauri: &str,
        webview_version: Option<String>,
    ) -> Self {
        let known = |value: &str| (!value.is_empty()).then(|| value.to_owned());
        Self {
            version: crate::VERSION.to_owned(),
            commit: known(commit),
            commit_date: known(commit_date),
            tauri: tauri.to_owned(),
            webview: webview_name().to_owned(),
            webview_version: webview_version.filter(|v| !v.is_empty()),
            platform: platform_name().to_owned(),
            helm: HELM_VERSION.to_owned(),
            kubectl: KUBECTL_VERSION.to_owned(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::pinned::{HELM_VERSION, KUBECTL_VERSION};
    use serde_json::json;

    #[test]
    fn serialises_in_camel_case() {
        let info = AppInfo::new("abc1234", "2026-11-10", "2.12.5", Some("2.46.0".into()));
        assert_eq!(
            serde_json::to_value(&info).unwrap(),
            json!({
                "version": crate::VERSION,
                "commit": "abc1234",
                "commitDate": "2026-11-10",
                "tauri": "2.12.5",
                "webview": webview_name(),
                "webviewVersion": "2.46.0",
                "platform": platform_name(),
                "helm": HELM_VERSION,
                "kubectl": KUBECTL_VERSION,
            })
        );
    }

    #[test]
    fn a_build_without_git_has_no_commit() {
        let info = AppInfo::new("", "", "2.12.5", None);
        assert_eq!(info.commit, None);
        assert_eq!(info.commit_date, None);
        assert_eq!(info.webview_version, None);
    }

    #[test]
    fn names_follow_the_target() {
        let expected = if cfg!(target_os = "macos") {
            ("WKWebView", "macOS")
        } else if cfg!(target_os = "windows") {
            ("WebView2", "Windows")
        } else {
            ("WebKitGTK", "Linux")
        };
        assert_eq!((webview_name(), platform_name()), expected);
    }
}
