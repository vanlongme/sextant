use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", tag = "kind", content = "path")]
#[ts(export)]
pub enum SyncSource {
    File(String),
    Dir(String),
}

/// The `.kube` directory under `home`, then each path in the `KUBECONFIG` value.
pub fn default_sources(home: &Path, kubeconfig_env: Option<&OsStr>) -> Vec<SyncSource> {
    let mut sources = vec![SyncSource::Dir(home.join(".kube").display().to_string())];
    if let Some(value) = kubeconfig_env {
        sources.extend(
            std::env::split_paths(value)
                .filter(|path| !path.as_os_str().is_empty())
                .map(|path| SyncSource::File(rooted(path).display().to_string())),
        );
    }
    sources
}

/// Cluster ids hash the path, so a path relative to the launch directory would
/// change them between runs.
fn rooted(path: PathBuf) -> PathBuf {
    if path.has_root() {
        return path;
    }
    std::path::absolute(&path).unwrap_or(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_sources_use_kube_dir_and_env_paths() {
        let env = std::env::join_paths(["/a/one", "/b/two"]).unwrap();
        let s = default_sources(Path::new("/h"), Some(&env));
        assert_eq!(
            s,
            vec![
                SyncSource::Dir(Path::new("/h").join(".kube").display().to_string()),
                SyncSource::File("/a/one".into()),
                SyncSource::File("/b/two".into()),
            ]
        );
    }

    #[test]
    fn default_sources_without_env_is_only_the_kube_dir() {
        let s = default_sources(Path::new("/h"), None);
        assert_eq!(
            s,
            vec![SyncSource::Dir(
                Path::new("/h").join(".kube").display().to_string()
            )]
        );
    }

    #[test]
    fn default_sources_skip_empty_env_segments() {
        let env = std::env::join_paths(["", "/a/one", ""]).unwrap();
        let s = default_sources(Path::new("/h"), Some(&env));
        assert_eq!(s.len(), 2);
        assert_eq!(s[1], SyncSource::File("/a/one".into()));
    }

    #[test]
    fn relative_env_path_becomes_absolute() {
        let env = std::ffi::OsString::from("relative-config");
        let s = default_sources(Path::new("/h"), Some(&env));
        let SyncSource::File(path) = &s[1] else {
            panic!("expected a file source, got {:?}", s[1]);
        };
        assert!(Path::new(path).is_absolute(), "{path}");
        assert!(path.ends_with("relative-config"), "{path}");
    }

    #[test]
    fn sync_source_round_trips_through_json() {
        let source = SyncSource::Dir("/h/.kube".into());
        let v = serde_json::to_value(&source).unwrap();
        assert_eq!(v["kind"], "dir");
        assert_eq!(v["path"], "/h/.kube");
        let back: SyncSource = serde_json::from_value(v).unwrap();
        assert_eq!(back, source);
    }
}
