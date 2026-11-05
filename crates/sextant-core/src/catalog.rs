//! The cluster catalog: what the sync found, combined with the user's settings,
//! and the kubeconfigs the user pasted in.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use serde_yaml_ng::Value;
use sha2::{Digest, Sha256};
use ts_rs::TS;

use crate::cluster::ConnectionState;
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::kubeconfig::{
    parse_contexts, strip_bom, write_private, yaml_error_text, ClusterId, ContextEntry, SyncSource,
    MAX_FILE_BYTES,
};
use crate::prefs::ClusterSettings;

const PASTED_DIR: &str = "kubeconfigs";
const PASTED_EXTENSION: &str = "yaml";
const PASTED_NAME_HEX_LEN: usize = 16;

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(rename_all = "camelCase", tag = "kind")]
#[ts(export)]
pub enum ClusterSource {
    Synced { path: String },
    Pasted { path: String },
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ClusterEntry {
    pub id: ClusterId,
    /// The display name when one is set, otherwise the context name.
    pub name: String,
    pub context_name: String,
    pub server: Option<String>,
    pub icon: Option<String>,
    pub source: ClusterSource,
    pub problem: Option<String>,
    pub state: ConnectionState,
}

fn invalid(message: impl Into<String>) -> IpcError {
    IpcError::new(ErrorCode::InvalidInput, message)
}

/// The directory of pasted kubeconfigs, which is always a sync source.
pub(crate) struct PastedConfigs {
    dir: PathBuf,
    /// A removal reads and rewrites a file, so a second one must wait its turn.
    writes: Mutex<()>,
}

impl PastedConfigs {
    pub(crate) fn open(data_dir: &Path) -> CoreResult<Self> {
        let dir = data_dir.join(PASTED_DIR);
        std::fs::create_dir_all(&dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
        }
        Ok(Self {
            dir,
            writes: Mutex::new(()),
        })
    }

    pub(crate) fn source(&self) -> SyncSource {
        SyncSource::Dir(self.dir.display().to_string())
    }

    pub(crate) fn holds(&self, source_path: &str) -> bool {
        Path::new(source_path).parent() == Some(self.dir.as_path())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ()> {
        self.writes.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Stores `yaml` under a name taken from its content, so pasting it again
    /// changes nothing, and returns the ids of its contexts.
    pub(crate) fn add(&self, yaml: &str) -> CoreResult<Vec<ClusterId>> {
        if yaml.len() as u64 > MAX_FILE_BYTES {
            return Err(invalid("the kubeconfig is over the 10 MiB limit"));
        }
        let path = self.dir.join(pasted_file_name(yaml));
        let entries = parse_contexts(&path, yaml.as_bytes()).map_err(invalid)?;
        if entries.is_empty() {
            return Err(invalid("the kubeconfig has no contexts"));
        }
        let _writes = self.lock();
        write_private(&path, yaml.as_bytes())?;
        Ok(entries.into_iter().map(|entry| entry.id).collect())
    }

    /// Returns whether a pasted file held `id`. The files are consulted rather
    /// than the sync's snapshot, which lags behind a paste by its debounce.
    pub(crate) fn remove(&self, id: &ClusterId) -> CoreResult<bool> {
        let _writes = self.lock();
        for item in std::fs::read_dir(&self.dir)? {
            let path = item?.path();
            if path.extension().is_none_or(|e| e != PASTED_EXTENSION) {
                continue;
            }
            let bytes = std::fs::read(&path)?;
            // A file the sync warns about cannot hold the entry being removed.
            let Ok(entries) = parse_contexts(&path, &bytes) else {
                continue;
            };
            if let Some(entry) = entries.iter().find(|entry| entry.id == *id) {
                rewrite_without_context(&path, &bytes, &entry.context_name)?;
                return Ok(true);
            }
        }
        Ok(false)
    }
}

fn pasted_file_name(yaml: &str) -> String {
    let digest = Sha256::digest(yaml.as_bytes());
    let hex: String = digest
        .iter()
        .take(PASTED_NAME_HEX_LEN / 2)
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("{hex}.{PASTED_EXTENSION}")
}

/// A name as `parse_contexts` reads it, which takes an unquoted `123` as text.
fn scalar_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

/// The `key` names (`cluster` or `user`) that `contexts` refer to.
fn referenced_names(contexts: &[Value], key: &str) -> HashSet<String> {
    contexts
        .iter()
        .filter_map(|item| item.get("context")?.get(key).and_then(scalar_text))
        .collect()
}

fn retain_named(section: Option<&mut Value>, names: &HashSet<String>) {
    if let Some(items) = section.and_then(Value::as_sequence_mut) {
        items.retain(|item| {
            let name = item.get("name").and_then(scalar_text);
            name.is_some_and(|name| names.contains(&name))
        });
    }
}

/// Removes `context` and the `users` and `clusters` entries nothing refers to any
/// more, so its credentials leave the disk. Deletes the file when `context` was
/// the last one in it.
fn rewrite_without_context(path: &Path, bytes: &[u8], context: &str) -> CoreResult<()> {
    let label = path.display();
    let mut document: Value = serde_yaml_ng::from_slice(strip_bom(bytes))
        .map_err(|e| invalid(format!("{label}: {}", yaml_error_text(&e))))?;
    let Some(contexts) = document
        .get_mut("contexts")
        .and_then(Value::as_sequence_mut)
    else {
        return Err(invalid(format!("{label} has no contexts")));
    };
    let before = contexts.len();
    contexts.retain(|item| item.get("name").and_then(scalar_text).as_deref() != Some(context));
    if contexts.len() == before {
        return Err(invalid(format!(
            "context \"{context}\" not found in {label}"
        )));
    }
    if contexts.is_empty() {
        std::fs::remove_file(path)?;
        return Ok(());
    }
    let users = referenced_names(contexts, "user");
    let clusters = referenced_names(contexts, "cluster");
    if let Value::Mapping(root) = &mut document {
        retain_named(root.get_mut("users"), &users);
        retain_named(root.get_mut("clusters"), &clusters);
        let current = root.get("current-context").and_then(scalar_text);
        if current.as_deref() == Some(context) {
            root.remove("current-context");
        }
    }
    let text = serde_yaml_ng::to_string(&document)
        .map_err(|e| IpcError::new(ErrorCode::Internal, format!("cannot serialize: {e}")))?;
    write_private(path, text.as_bytes())
}

fn display_name(settings: Option<&ClusterSettings>) -> Option<String> {
    settings?
        .display_name
        .as_ref()
        .filter(|name| !name.trim().is_empty())
        .cloned()
}

pub(crate) fn build_entries(
    contexts: Vec<ContextEntry>,
    settings: &HashMap<ClusterId, ClusterSettings>,
    pasted: &PastedConfigs,
    state_of: impl Fn(&ClusterId) -> ConnectionState,
) -> Vec<ClusterEntry> {
    contexts
        .into_iter()
        .map(|context| {
            let own = settings.get(&context.id);
            let source = if pasted.holds(&context.source_path) {
                ClusterSource::Pasted {
                    path: context.source_path,
                }
            } else {
                ClusterSource::Synced {
                    path: context.source_path,
                }
            };
            ClusterEntry {
                name: display_name(own).unwrap_or_else(|| context.context_name.clone()),
                icon: own.and_then(|s| s.icon.clone()),
                state: state_of(&context.id),
                id: context.id,
                context_name: context.context_name,
                server: context.server,
                source,
                problem: context.problem,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TWO: &str = "apiVersion: v1\nkind: Config\n\
        clusters:\n- { name: c1, cluster: { server: \"https://x\" } }\n\
        users:\n- { name: u1, user: { token: t } }\n\
        contexts:\n\
        - { name: one, context: { cluster: c1, user: u1 } }\n\
        - { name: two, context: { cluster: c1, user: u1 } }\n\
        current-context: one\n";

    fn context(name: &str, source_path: &str) -> ContextEntry {
        ContextEntry {
            id: format!("id-{name}"),
            context_name: name.to_owned(),
            cluster_name: "c1".to_owned(),
            user_name: "u1".to_owned(),
            namespace: None,
            server: Some("https://x".to_owned()),
            source_path: source_path.to_owned(),
            uses_exec: false,
            problem: None,
        }
    }

    #[test]
    fn pasted_name_is_a_prefix_of_the_content_hash() {
        // printf 'x' | sha256sum, first 16 hex characters.
        assert_eq!(pasted_file_name("x"), "2d711642b726b044.yaml");
    }

    #[test]
    fn entries_outside_the_pasted_directory_are_synced() {
        let data = tempfile::tempdir().unwrap();
        let pasted = PastedConfigs::open(data.path()).unwrap();
        let inside = pasted.dir.join("abc.yaml").display().to_string();
        let nested = pasted.dir.join("sub").join("abc.yaml");
        let nested = nested.display().to_string();

        let entries = build_entries(
            vec![
                context("a", &inside),
                context("b", "/h/.kube/config"),
                context("c", &nested),
            ],
            &HashMap::new(),
            &pasted,
            |_| ConnectionState::Disconnected,
        );

        assert_eq!(entries[0].source, ClusterSource::Pasted { path: inside });
        assert_eq!(
            entries[1].source,
            ClusterSource::Synced {
                path: "/h/.kube/config".to_owned()
            }
        );
        assert_eq!(entries[2].source, ClusterSource::Synced { path: nested });
    }

    #[test]
    fn entry_serializes_for_the_ui() {
        let data = tempfile::tempdir().unwrap();
        let pasted = PastedConfigs::open(data.path()).unwrap();
        let entries = build_entries(
            vec![context("a", "/h/.kube/config")],
            &HashMap::new(),
            &pasted,
            |_| ConnectionState::Disconnected,
        );

        let v = serde_json::to_value(&entries[0]).unwrap();

        assert_eq!(v["contextName"], "a");
        assert_eq!(v["source"]["kind"], "synced");
        assert_eq!(v["source"]["path"], "/h/.kube/config");
        assert_eq!(v["state"]["status"], "disconnected");
    }

    #[test]
    fn removal_rewrites_without_the_context_and_clears_current_context() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.yaml");
        std::fs::write(&path, TWO).unwrap();

        rewrite_without_context(&path, TWO.as_bytes(), "one").unwrap();

        let bytes = std::fs::read(&path).unwrap();
        let names: Vec<String> = parse_contexts(&path, &bytes)
            .unwrap()
            .into_iter()
            .map(|entry| entry.context_name)
            .collect();
        assert_eq!(names, ["two"]);
        let document: Value = serde_yaml_ng::from_slice(&bytes).unwrap();
        assert!(document.get("current-context").is_none());
        assert!(document.get("clusters").is_some());
    }

    #[test]
    fn removal_keeps_a_current_context_that_stays() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.yaml");
        std::fs::write(&path, TWO).unwrap();

        rewrite_without_context(&path, TWO.as_bytes(), "two").unwrap();

        let document: Value = serde_yaml_ng::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(
            document.get("current-context").and_then(Value::as_str),
            Some("one")
        );
    }

    #[test]
    fn removal_finds_an_unquoted_numeric_name() {
        let text = "kind: Config\ncontexts:\n\
            - { name: 123, context: { cluster: c, user: u } }\n\
            - { name: other, context: { cluster: c, user: u } }\n";
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.yaml");
        std::fs::write(&path, text).unwrap();
        let listed = parse_contexts(&path, text.as_bytes()).unwrap();
        assert_eq!(listed[0].context_name, "123");

        rewrite_without_context(&path, text.as_bytes(), "123").unwrap();

        let left = parse_contexts(&path, &std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].context_name, "other");
    }

    #[test]
    fn remove_skips_files_it_cannot_parse() {
        let data = tempfile::tempdir().unwrap();
        let pasted = PastedConfigs::open(data.path()).unwrap();
        std::fs::write(pasted.dir.join("broken.yaml"), "x: [").unwrap();
        let ids = pasted.add(TWO).unwrap();

        assert!(pasted.remove(&ids[0]).unwrap());
        assert!(!pasted.remove(&ids[0]).unwrap());
    }
}
