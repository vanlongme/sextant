use skopos_core::app_info::AppInfo;

/// Version facts for About (spec C §8.2). It only reads constants, so it is sync.
#[tauri::command]
pub fn app_info() -> AppInfo {
    build_info(tauri::webview_version().ok())
}

pub(crate) fn build_info(webview_version: Option<String>) -> AppInfo {
    AppInfo::new(
        env!("SKOPOS_COMMIT"),
        env!("SKOPOS_COMMIT_DATE"),
        tauri::VERSION,
        webview_version,
    )
}

#[cfg(test)]
mod tests {
    use skopos_core::tools::pinned::{HELM_VERSION, KUBECTL_VERSION};

    #[test]
    fn app_info_fills_every_field() {
        let info = super::build_info(Some("2.46.0".into()));
        assert_eq!(info.version, skopos_core::VERSION);
        assert_eq!(info.tauri, tauri::VERSION);
        assert_eq!(info.webview_version.as_deref(), Some("2.46.0"));
        assert!(["WKWebView", "WebView2", "WebKitGTK"].contains(&info.webview.as_str()));
        assert!(["macOS", "Windows", "Linux"].contains(&info.platform.as_str()));
        assert_eq!(info.helm, HELM_VERSION);
        assert_eq!(info.kubectl, KUBECTL_VERSION);
        // The tests build from a git checkout, so build.rs found the commit.
        assert!(info.commit.as_deref().is_some_and(|c| c.len() >= 7));
        assert!(info.commit_date.as_deref().is_some_and(|d| d.len() == 10));
    }
}
