//! User settings kept in the JSON stores.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::kubeconfig::SyncSource;

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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefs_serialize_camel_case() {
        let prefs = Prefs {
            theme: Theme::Dark,
            sync_sources: vec![SyncSource::Dir("/h/.kube".into())],
        };
        let v = serde_json::to_value(&prefs).unwrap();
        assert_eq!(v["theme"], "dark");
        assert_eq!(v["syncSources"][0]["kind"], "dir");
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
