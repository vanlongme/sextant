use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_yaml_ng::Value;
use sha2::{Digest, Sha256};
use ts_rs::TS;

pub type ClusterId = String;

/// The first 32 hex characters of `sha256(path + "\0" + context)`.
pub fn cluster_id(abs_path: &Path, context: &str) -> ClusterId {
    let mut hasher = Sha256::new();
    hasher.update(abs_path.to_string_lossy().as_bytes());
    hasher.update([0u8]);
    hasher.update(context.as_bytes());
    hasher
        .finalize()
        .iter()
        .take(16)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ContextEntry {
    pub id: ClusterId,
    pub context_name: String,
    pub cluster_name: String,
    pub user_name: String,
    pub namespace: Option<String>,
    pub server: Option<String>,
    pub source_path: String,
    pub uses_exec: bool,
    pub problem: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RawConfig {
    kind: Value,
    clusters: Option<Vec<RawCluster>>,
    users: Option<Vec<RawUser>>,
    contexts: Option<Vec<RawContext>>,
}

#[derive(Deserialize)]
struct RawCluster {
    name: String,
    #[serde(default)]
    cluster: RawClusterBody,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RawClusterBody {
    server: Option<String>,
}

#[derive(Deserialize)]
struct RawUser {
    name: String,
    #[serde(default)]
    user: Option<RawUserBody>,
}

// Only `exec` is looked at, so the rest of the section stays unmodelled.
#[derive(Deserialize, Default)]
#[serde(default)]
struct RawUserBody {
    exec: Value,
}

#[derive(Deserialize)]
struct RawContext {
    name: String,
    #[serde(default)]
    context: RawContextBody,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RawContextBody {
    cluster: Option<String>,
    user: Option<String>,
    namespace: Option<String>,
}

/// A parsed document, and whether its shape identifies it as a kubeconfig.
pub(super) struct ParsedFile {
    pub entries: Vec<ContextEntry>,
    pub is_kubeconfig: bool,
}

/// Stands in for serde's type errors, which quote the offending value. In a
/// kubeconfig, or in the wrong file picked by mistake, that may be a credential.
pub(super) const NOT_KUBECONFIG: &str = "not in kubeconfig format";

/// Stands in for the parser's message, which can quote the offending value.
pub(crate) fn yaml_error_text(err: &serde_yaml_ng::Error) -> String {
    with_location("invalid kubeconfig", err)
}

pub(crate) fn with_location(message: &str, err: &serde_yaml_ng::Error) -> String {
    match err.location() {
        Some(at) => format!("{message} at line {}, column {}", at.line(), at.column()),
        None => message.to_owned(),
    }
}

pub(crate) fn strip_bom(bytes: &[u8]) -> &[u8] {
    bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes)
}

fn read_config(bytes: &[u8]) -> Result<RawConfig, String> {
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(RawConfig::default());
    }
    // Read directly rather than through `Value`, which would type an unquoted
    // name such as `123` as a number and reject it where a string is expected.
    // An empty or comment-only document deserializes as `None`.
    match serde_yaml_ng::from_slice::<Option<RawConfig>>(bytes) {
        Ok(raw) => Ok(raw.unwrap_or_default()),
        // Without a target type what still fails is the syntax or a repeated key.
        Err(shape) => Err(match serde_yaml_ng::from_slice::<Value>(bytes) {
            Ok(_) => with_location(NOT_KUBECONFIG, &shape),
            Err(syntax) => yaml_error_text(&syntax),
        }),
    }
}

pub(super) fn parse_file(path: &Path, bytes: &[u8]) -> Result<ParsedFile, String> {
    let raw = read_config(strip_bom(bytes))?;
    let is_kubeconfig =
        raw.kind.as_str() == Some("Config") || raw.contexts.is_some() || raw.clusters.is_some();
    let clusters = raw.clusters.unwrap_or_default();
    let users = raw.users.unwrap_or_default();

    let mut entries: Vec<ContextEntry> = Vec::new();
    for context in raw.contexts.unwrap_or_default() {
        if entries.iter().any(|e| e.context_name == context.name) {
            continue;
        }
        let cluster_name = context.context.cluster.unwrap_or_default();
        let user_name = context.context.user.unwrap_or_default();
        let cluster = clusters.iter().find(|c| c.name == cluster_name);
        let user = users.iter().find(|u| u.name == user_name);
        let uses_exec = user
            .and_then(|u| u.user.as_ref())
            .is_some_and(|body| !body.exec.is_null());
        let problem = match (cluster.is_some(), user.is_some()) {
            (true, true) => None,
            (false, true) => Some(format!(
                "context refers to missing cluster \"{cluster_name}\""
            )),
            (true, false) => Some(format!("context refers to missing user \"{user_name}\"")),
            (false, false) => Some(format!(
                "context refers to missing cluster \"{cluster_name}\" and missing user \"{user_name}\""
            )),
        };
        entries.push(ContextEntry {
            id: cluster_id(path, &context.name),
            server: cluster.and_then(|c| c.cluster.server.clone()),
            namespace: context.context.namespace.filter(|n| !n.is_empty()),
            source_path: path.display().to_string(),
            context_name: context.name,
            cluster_name,
            user_name,
            uses_exec,
            problem,
        });
    }
    Ok(ParsedFile {
        entries,
        is_kubeconfig,
    })
}

/// Lists the contexts in kubeconfig text. The error is a fixed message, with the
/// location when the parser has one, that quotes nothing from the file.
pub fn parse_contexts(path: &Path, bytes: &[u8]) -> Result<Vec<ContextEntry>, String> {
    parse_file(path, bytes).map(|parsed| parsed.entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    const TWO: &str = r#"
apiVersion: v1
kind: Config
clusters:
- name: c1
  cluster: { server: "https://1.2.3.4" }
users:
- name: u1
  user: { token: abc }
- name: u2
  user:
    exec: { apiVersion: client.authentication.k8s.io/v1, command: aws, args: [eks] }
contexts:
- name: one
  context: { cluster: c1, user: u1, namespace: ns1 }
- name: two
  context: { cluster: c1, user: u2 }
- name: broken
  context: { cluster: missing, user: u1 }
current-context: one
"#;

    #[test]
    fn cluster_id_is_stable_and_depends_on_path_and_context() {
        let a = cluster_id(Path::new("/k/config"), "one");
        assert_eq!(a, cluster_id(Path::new("/k/config"), "one"));
        assert_eq!(a.len(), 32);
        assert_ne!(a, cluster_id(Path::new("/k/config"), "two"));
        assert_ne!(a, cluster_id(Path::new("/k/other"), "one"));
    }

    #[test]
    fn cluster_id_is_the_sha256_prefix_of_path_nul_context() {
        // printf '/k/config\0one' | sha256sum, first 32 hex characters.
        assert_eq!(
            cluster_id(Path::new("/k/config"), "one"),
            "d53014bc5dd862540f3e54f7c35c3196"
        );
    }

    #[test]
    fn parses_all_contexts_and_flags_broken_references() {
        let e = parse_contexts(Path::new("/k/config"), TWO.as_bytes()).unwrap();
        assert_eq!(e.len(), 3);
        assert_eq!(e[0].namespace.as_deref(), Some("ns1"));
        assert_eq!(e[0].server.as_deref(), Some("https://1.2.3.4"));
        assert!(!e[0].uses_exec);
        assert!(e[1].uses_exec);
        assert!(e[2].problem.as_deref().unwrap().contains("missing"));
        assert!(e[0].problem.is_none());
    }

    #[test]
    fn entry_carries_names_source_and_id() {
        let e = parse_contexts(Path::new("/k/config"), TWO.as_bytes()).unwrap();
        assert_eq!(e[0].id, cluster_id(Path::new("/k/config"), "one"));
        assert_eq!(e[0].context_name, "one");
        assert_eq!(e[0].cluster_name, "c1");
        assert_eq!(e[0].user_name, "u1");
        assert_eq!(e[0].source_path, "/k/config");
    }

    #[test]
    fn problem_names_the_missing_cluster_and_user() {
        let raw = br#"
contexts:
- name: a
  context: { cluster: nope, user: nobody }
- name: b
  context: { cluster: c1, user: nobody }
clusters:
- { name: c1, cluster: { server: "https://x" } }
"#;
        let e = parse_contexts(Path::new("/k/config"), raw).unwrap();
        let a = e[0].problem.as_deref().unwrap();
        assert!(a.contains(r#"missing cluster "nope""#), "{a}");
        assert!(a.contains(r#"user "nobody""#), "{a}");
        assert_eq!(
            e[1].problem.as_deref(),
            Some(r#"context refers to missing user "nobody""#)
        );
    }

    #[test]
    fn bom_and_crlf_parse() {
        let mut raw = vec![0xEF, 0xBB, 0xBF];
        raw.extend_from_slice(TWO.replace('\n', "\r\n").as_bytes());
        assert_eq!(
            parse_contexts(Path::new("/k/config"), &raw).unwrap().len(),
            3
        );
    }

    #[test]
    fn empty_file_has_no_entries_and_no_error() {
        assert!(parse_contexts(Path::new("/k/config"), b"")
            .unwrap()
            .is_empty());
        assert!(parse_contexts(Path::new("/k/config"), b"\n\n")
            .unwrap()
            .is_empty());
        assert!(
            parse_contexts(Path::new("/k/config"), b"# only a comment\n")
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn null_sections_are_accepted() {
        let raw = b"apiVersion: v1\nkind: Config\nclusters: null\ncontexts: null\nusers: null\n";
        assert!(parse_contexts(Path::new("/k/config"), raw)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn invalid_yaml_is_an_error_naming_the_cause() {
        let err = parse_contexts(Path::new("/k/config"), b"clusters: [unterminated").unwrap_err();
        assert!(err.contains("line"), "{err}");
    }

    #[test]
    fn a_wrongly_shaped_document_gives_a_message_without_its_text() {
        for document in [
            "SECRET-TOKEN-abc123\n",
            "-----BEGIN PRIVATE KEY-----\nSECRET-KEY-abc123\n-----END PRIVATE KEY-----\n",
            "users: SECRET-TOKEN-abc123\n",
            "users:\n- SECRET-TOKEN-abc123\n",
            "clusters: SECRET-TOKEN-abc123\n",
            "contexts:\n- SECRET-TOKEN-abc123\n",
        ] {
            let err = parse_contexts(Path::new("/k/config"), document.as_bytes()).unwrap_err();
            assert!(err.starts_with(NOT_KUBECONFIG), "{document}: {err}");
            assert!(!err.contains("SECRET"), "{document}: {err}");
        }
    }

    #[test]
    fn a_wrongly_shaped_document_reports_where_it_went_wrong() {
        let raw = b"clusters: []\nusers:\n- name: u\n  user: tok-SECRET\n";
        let err = parse_contexts(Path::new("/k/config"), raw).unwrap_err();
        assert_eq!(err, format!("{NOT_KUBECONFIG} at line 4, column 9"));
    }

    #[test]
    fn unquoted_scalar_names_are_read_as_text() {
        let raw = br#"
clusters:
- { name: 1.5, cluster: { server: "https://x" } }
users:
- { name: true, user: { token: t } }
contexts:
- { name: 123, context: { cluster: 1.5, user: true, namespace: 7 } }
"#;
        let e = parse_contexts(Path::new("/k/config"), raw).unwrap();
        assert_eq!(e[0].context_name, "123");
        assert_eq!(e[0].cluster_name, "1.5");
        assert_eq!(e[0].user_name, "true");
        assert_eq!(e[0].namespace.as_deref(), Some("7"));
        assert!(e[0].problem.is_none());
    }

    #[test]
    fn a_document_that_is_not_a_mapping_is_an_error() {
        assert!(parse_contexts(Path::new("/k/config"), b"just some words").is_err());
    }

    #[test]
    fn duplicate_context_names_keep_the_first() {
        let raw = br#"
clusters:
- { name: c1, cluster: { server: "https://first" } }
- { name: c2, cluster: { server: "https://second" } }
users:
- { name: u1, user: {} }
contexts:
- { name: same, context: { cluster: c1, user: u1 } }
- { name: same, context: { cluster: c2, user: u1 } }
"#;
        let e = parse_contexts(Path::new("/k/config"), raw).unwrap();
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].cluster_name, "c1");
    }

    #[test]
    fn unknown_fields_are_ignored() {
        let raw = br#"
preferences: { colors: true }
clusters:
- { name: c1, extra: 1, cluster: { server: "https://x", insecure-skip-tls-verify: true } }
users:
- { name: u1, user: { client-key-data: abc } }
contexts:
- { name: a, context: { cluster: c1, user: u1, extensions: [] } }
"#;
        let e = parse_contexts(Path::new("/k/config"), raw).unwrap();
        assert_eq!(e.len(), 1);
        assert!(e[0].problem.is_none());
    }

    #[test]
    fn parse_errors_never_quote_values() {
        for bad in [
            "tok-SECRET",
            "users: tok-SECRET",
            "users:\n- name: u\n  user: tok-SECRET\n",
            "clusters: [{name: tok-SECRET, cluster: 5}]\ncontexts: 7\n",
            "kind: {tok-SECRET: 1, tok-SECRET: 2}\n",
        ] {
            let err = parse_contexts(Path::new("/k/config"), bad.as_bytes()).unwrap_err();
            assert!(!err.contains("tok-SECRET"), "{bad:?} leaked in {err:?}");
        }
    }

    #[test]
    fn parse_errors_report_a_location() {
        let err = parse_contexts(Path::new("/k/config"), b"clusters: [unterminated").unwrap_err();
        assert!(err.contains("line"), "{err}");
    }

    #[test]
    fn syntax_errors_are_a_fixed_message_with_a_location() {
        let err = parse_contexts(Path::new("/k/config"), b"clusters: [unterminated").unwrap_err();
        assert!(err.starts_with("invalid kubeconfig at line "), "{err}");
    }

    #[test]
    fn a_user_without_a_body_is_accepted() {
        let raw = br#"
clusters:
- { name: c1, cluster: { server: "https://x" } }
users:
- { name: u1, user: null }
- { name: u2 }
contexts:
- { name: a, context: { cluster: c1, user: u1 } }
- { name: b, context: { cluster: c1, user: u2 } }
"#;
        let e = parse_contexts(Path::new("/k/config"), raw).unwrap();
        assert!(e
            .iter()
            .all(|entry| entry.problem.is_none() && !entry.uses_exec));
    }

    #[test]
    fn serializes_camel_case() {
        let e = parse_contexts(Path::new("/k/config"), TWO.as_bytes()).unwrap();
        let v = serde_json::to_value(&e[0]).unwrap();
        assert_eq!(v["contextName"], "one");
        assert_eq!(v["sourcePath"], "/k/config");
        assert_eq!(v["usesExec"], false);
    }
}
