//! User settings kept in the JSON stores.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::kubeconfig::SyncSource;
use crate::metrics::MetricsProviderSetting;

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS, PartialEq)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct ClusterSettings {
    pub display_name: Option<String>,
    /// A data URL.
    pub icon: Option<String>,
    pub default_namespace: Option<String>,
    pub accessible_namespaces: Vec<String>,
    pub terminal_cwd: Option<String>,
    pub proxy_url: Option<String>,
    pub node_shell_image: Option<String>,
    /// How metrics are read for this cluster (F16).
    pub metrics_provider: MetricsProviderSetting,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum Theme {
    #[default]
    System,
    Dark,
    Light,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS, PartialEq)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct Prefs {
    pub theme: Theme,
    /// Seeded from `default_sources` on first run. A saved empty list stays empty.
    pub sync_sources: Vec<SyncSource>,
    /// The local terminal's shell. `None` picks one per F11.
    #[ts(optional = nullable)]
    pub terminal_shell: Option<String>,
    /// Used instead of looking helm up (F14). `None`: `PATH`, then the managed copy.
    #[ts(optional = nullable)]
    pub helm_path: Option<String>,
    #[ts(optional = nullable)]
    pub kubectl_path: Option<String>,
    /// For downloads and helm, such as `http://proxy.example:3128`. `None`: the system proxy.
    #[ts(optional = nullable)]
    pub http_proxy: Option<String>,
}

impl Prefs {
    /// Trims the tool fields and treats blank ones as not set. The proxy must be an http or
    /// https URL.
    pub fn normalized(mut self) -> CoreResult<Prefs> {
        for field in [
            &mut self.helm_path,
            &mut self.kubectl_path,
            &mut self.http_proxy,
        ] {
            *field = field
                .take()
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty());
        }
        if let Some(proxy) = self.http_proxy.as_deref() {
            let valid = url::Url::parse(proxy)
                .is_ok_and(|url| matches!(url.scheme(), "http" | "https") && url.host().is_some());
            if !valid {
                // The value is not repeated: it may hold a password.
                return Err(IpcError::new(
                    ErrorCode::InvalidInput,
                    "the HTTP proxy must be an http or https URL, such as http://proxy.example:3128",
                ));
            }
        }
        Ok(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefs_serialize_camel_case() {
        let prefs = Prefs {
            theme: Theme::Dark,
            sync_sources: vec![SyncSource::Dir("/h/.kube".into())],
            http_proxy: Some("http://proxy.example:3128".into()),
            ..Prefs::default()
        };
        let v = serde_json::to_value(&prefs).unwrap();
        assert_eq!(v["theme"], "dark");
        assert_eq!(v["syncSources"][0]["kind"], "dir");
        assert_eq!(v["httpProxy"], "http://proxy.example:3128");
        assert!(v["helmPath"].is_null());
    }

    #[test]
    fn blank_tool_fields_are_saved_as_none_and_values_are_trimmed() {
        let prefs = Prefs {
            helm_path: Some("  ".into()),
            kubectl_path: Some(" /usr/local/bin/kubectl ".into()),
            http_proxy: Some("".into()),
            ..Prefs::default()
        }
        .normalized()
        .unwrap();
        assert_eq!(prefs.helm_path, None);
        assert_eq!(
            prefs.kubectl_path.as_deref(),
            Some("/usr/local/bin/kubectl")
        );
        assert_eq!(prefs.http_proxy, None);
    }

    #[test]
    fn only_an_http_or_https_proxy_is_accepted() {
        for good in [
            "http://proxy.example:3128",
            " https://user:pw@proxy.example ",
        ] {
            let prefs = Prefs {
                http_proxy: Some(good.into()),
                ..Prefs::default()
            };
            assert!(prefs.normalized().is_ok(), "{good}");
        }
        for bad in [
            "socks5://proxy.example:1080",
            "proxy.example:3128",
            "http://",
            "not a url",
        ] {
            let prefs = Prefs {
                http_proxy: Some(bad.into()),
                ..Prefs::default()
            };
            let error = prefs.normalized().unwrap_err();
            assert_eq!(error.code, ErrorCode::InvalidInput, "{bad}");
        }
    }

    #[test]
    fn missing_fields_take_their_defaults() {
        let prefs: Prefs = serde_json::from_str("{}").unwrap();
        assert_eq!(prefs, Prefs::default());
        let settings: ClusterSettings = serde_json::from_str(r#"{"displayName":"Prod"}"#).unwrap();
        assert_eq!(settings.display_name.as_deref(), Some("Prod"));
        assert!(settings.accessible_namespaces.is_empty());
    }
}
