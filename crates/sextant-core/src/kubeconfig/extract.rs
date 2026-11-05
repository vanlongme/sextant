use std::io::Write;
use std::path::Path;

use serde_yaml_ng::{Mapping, Value};

use super::parse::{strip_bom, NOT_KUBECONFIG};
use crate::error::{CoreResult, ErrorCode, IpcError};

const CLUSTER_PATH_KEYS: [&str; 1] = ["certificate-authority"];
const USER_PATH_KEYS: [&str; 3] = ["client-certificate", "client-key", "tokenFile"];

fn invalid(message: String) -> IpcError {
    IpcError::new(ErrorCode::InvalidInput, message)
}

fn find_named(root: &Mapping, section: &str, name: &str) -> Option<Value> {
    root.get(section)?
        .as_sequence()?
        .iter()
        .find(|item| item.get("name").and_then(Value::as_str) == Some(name))
        .cloned()
}

fn make_paths_absolute(item: &mut Value, body: &str, keys: &[&str], base: &Path) {
    let Some(body) = item.get_mut(body) else {
        return;
    };
    for key in keys {
        if let Some(Value::String(path)) = body.get_mut(*key) {
            make_absolute(path, base);
        }
    }
}

fn make_absolute(path: &mut String, base: &Path) {
    if !path.is_empty() && Path::new(path.as_str()).is_relative() {
        *path = base.join(path.as_str()).display().to_string();
    }
}

/// A command with a separator is a file relative to the kubeconfig, which the
/// extracted copy no longer sits beside. A bare name stays a `PATH` lookup.
fn make_exec_command_absolute(user: &mut Value, base: &Path) {
    let command = user
        .get_mut("user")
        .and_then(|body| body.get_mut("exec"))
        .and_then(|exec| exec.get_mut("command"));
    if let Some(Value::String(command)) = command {
        if command.contains(std::path::is_separator) {
            make_absolute(command, base);
        }
    }
}

pub(crate) fn write_private(dest: &Path, bytes: &[u8]) -> CoreResult<()> {
    let dir = dest
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir)?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tmp.as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    tmp.write_all(bytes)?;
    tmp.as_file().sync_all()?;
    tmp.persist(dest).map_err(|e| e.error)?;
    Ok(())
}

/// Writes a kubeconfig holding only `context`, with `current-context` set and
/// file references absolute, so it works from any directory and leaves the
/// user's own file untouched.
pub fn extract_context(source: &Path, context: &str, dest: &Path) -> CoreResult<()> {
    let raw = std::fs::read(source)?;
    let label = source.display();
    // Through `Value`, whose errors have no type error to quote a value in.
    let document: Value = serde_yaml_ng::from_slice(strip_bom(&raw))
        .map_err(|e| invalid(format!("{label} is not a valid kubeconfig: {e}")))?;
    let Value::Mapping(mut root) = document else {
        return Err(invalid(format!("{label} is {NOT_KUBECONFIG}")));
    };

    let selected = find_named(&root, "contexts", context)
        .ok_or_else(|| invalid(format!("context \"{context}\" not found in {label}")))?;
    let reference = |key: &str| {
        selected
            .get("context")
            .and_then(|body| body.get(key))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let cluster_name = reference("cluster");
    let user_name = reference("user");
    let mut cluster = find_named(&root, "clusters", &cluster_name).ok_or_else(|| {
        invalid(format!(
            "context \"{context}\" refers to missing cluster \"{cluster_name}\""
        ))
    })?;
    let mut user = find_named(&root, "users", &user_name).ok_or_else(|| {
        invalid(format!(
            "context \"{context}\" refers to missing user \"{user_name}\""
        ))
    })?;

    let absolute_source = std::path::absolute(source)?;
    let base = absolute_source.parent().unwrap_or(Path::new(""));
    make_paths_absolute(&mut cluster, "cluster", &CLUSTER_PATH_KEYS, base);
    make_paths_absolute(&mut user, "user", &USER_PATH_KEYS, base);
    make_exec_command_absolute(&mut user, base);

    for (key, value) in [
        ("contexts", Value::Sequence(vec![selected])),
        ("clusters", Value::Sequence(vec![cluster])),
        ("users", Value::Sequence(vec![user])),
        ("current-context", Value::String(context.to_owned())),
    ] {
        root.insert(Value::String(key.to_owned()), value);
    }

    let text = serde_yaml_ng::to_string(&root)
        .map_err(|e| IpcError::new(ErrorCode::Internal, format!("cannot serialize: {e}")))?;
    write_private(dest, text.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    const CONFIG: &str = r#"
apiVersion: v1
kind: Config
clusters:
- { name: c1, cluster: { server: "https://x", certificate-authority: ca.crt } }
- { name: c2, cluster: { server: "https://y" } }
users:
- { name: u1, user: { token: t } }
contexts:
- { name: one, context: { cluster: c1, user: u1 } }
- { name: two, context: { cluster: c2, user: u1 } }
current-context: two
"#;

    fn read_yaml(path: &Path) -> Value {
        serde_yaml_ng::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn extract_keeps_one_context_and_makes_paths_absolute() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("ca.crt"), "x").unwrap();
        let src = dir.path().join("config");
        std::fs::write(&src, CONFIG).unwrap();
        let dest = dir.path().join("out.yaml");
        extract_context(&src, "one", &dest).unwrap();
        let out: serde_yaml_ng::Value =
            serde_yaml_ng::from_str(&std::fs::read_to_string(&dest).unwrap()).unwrap();
        assert_eq!(out["current-context"], "one");
        assert_eq!(out["contexts"].as_sequence().unwrap().len(), 1);
        assert_eq!(out["clusters"].as_sequence().unwrap().len(), 1);
        let ca = out["clusters"][0]["cluster"]["certificate-authority"]
            .as_str()
            .unwrap();
        assert!(Path::new(ca).is_absolute());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&dest).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn extract_rewrites_every_relative_path_against_the_source_dir() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("config");
        std::fs::write(
            &src,
            r#"
clusters:
- { name: c1, cluster: { server: "https://x", certificate-authority: certs/ca.crt } }
users:
- name: u1
  user: { client-certificate: c.crt, client-key: c.key, tokenFile: token }
contexts:
- { name: one, context: { cluster: c1, user: u1 } }
"#,
        )
        .unwrap();
        let dest = dir.path().join("out.yaml");
        extract_context(&src, "one", &dest).unwrap();
        let out = read_yaml(&dest);
        let user = &out["users"][0]["user"];
        let expect = |rel: &str| dir.path().join(rel).display().to_string();
        assert_eq!(
            out["clusters"][0]["cluster"]["certificate-authority"]
                .as_str()
                .unwrap(),
            expect("certs/ca.crt")
        );
        assert_eq!(
            user["client-certificate"].as_str().unwrap(),
            expect("c.crt")
        );
        assert_eq!(user["client-key"].as_str().unwrap(), expect("c.key"));
        assert_eq!(user["tokenFile"].as_str().unwrap(), expect("token"));
    }

    #[test]
    fn extract_leaves_absolute_paths_and_inline_data_alone() {
        let dir = tempfile::tempdir().unwrap();
        let abs = dir.path().join("elsewhere.crt").display().to_string();
        let src = dir.path().join("config");
        std::fs::write(
            &src,
            format!(
                r#"
clusters:
- {{ name: c1, cluster: {{ server: "https://x", certificate-authority: '{abs}' }} }}
users:
- {{ name: u1, user: {{ client-key-data: aGVsbG8= }} }}
contexts:
- {{ name: one, context: {{ cluster: c1, user: u1 }} }}
"#
            ),
        )
        .unwrap();
        let dest = dir.path().join("out.yaml");
        extract_context(&src, "one", &dest).unwrap();
        let out = read_yaml(&dest);
        assert_eq!(
            out["clusters"][0]["cluster"]["certificate-authority"]
                .as_str()
                .unwrap(),
            abs
        );
        assert_eq!(
            out["users"][0]["user"]["client-key-data"].as_str().unwrap(),
            "aGVsbG8="
        );
    }

    fn extracted_exec_command(dir: &Path, command: &str) -> String {
        let src = dir.join("config");
        std::fs::write(
            &src,
            format!(
                r#"
clusters:
- {{ name: c1, cluster: {{ server: "https://x" }} }}
users:
- name: u1
  user:
    exec: {{ apiVersion: client.authentication.k8s.io/v1, command: '{command}' }}
contexts:
- {{ name: one, context: {{ cluster: c1, user: u1 }} }}
"#
            ),
        )
        .unwrap();
        let dest = dir.join("out.yaml");
        extract_context(&src, "one", &dest).unwrap();
        read_yaml(&dest)["users"][0]["user"]["exec"]["command"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    #[test]
    fn extract_resolves_an_exec_command_with_a_separator_against_the_source_dir() {
        let dir = tempfile::tempdir().unwrap();
        for command in ["./bin/plugin", "bin/plugin"] {
            let out = extracted_exec_command(dir.path(), command);
            assert_eq!(Path::new(&out), dir.path().join("bin/plugin"), "{command}");
        }
    }

    #[test]
    fn extract_leaves_a_bare_or_absolute_exec_command_alone() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(extracted_exec_command(dir.path(), "aws"), "aws");
        let abs = dir.path().join("plugin").display().to_string();
        assert_eq!(extracted_exec_command(dir.path(), &abs), abs);
    }

    #[test]
    fn extract_error_for_a_wrongly_shaped_source_omits_its_text() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("config");
        std::fs::write(&src, "SECRET-TOKEN-abc123\n").unwrap();
        let err = extract_context(&src, "one", &dir.path().join("out.yaml")).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidInput);
        assert!(!err.message.contains("SECRET"), "{}", err.message);
        assert!(err.message.contains(NOT_KUBECONFIG), "{}", err.message);
    }

    #[test]
    fn extract_replaces_an_existing_destination_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("config");
        std::fs::write(&src, CONFIG).unwrap();
        let out_dir = dir.path().join("out");
        std::fs::create_dir(&out_dir).unwrap();
        let dest = out_dir.join("ctx.yaml");
        std::fs::write(&dest, "old").unwrap();
        extract_context(&src, "two", &dest).unwrap();
        assert_eq!(read_yaml(&dest)["current-context"], "two");
        assert_eq!(std::fs::read_dir(&out_dir).unwrap().count(), 1);
    }

    #[test]
    fn extract_reads_a_source_with_a_bom() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("config");
        let mut raw = vec![0xEF, 0xBB, 0xBF];
        raw.extend_from_slice(CONFIG.as_bytes());
        std::fs::write(&src, raw).unwrap();
        let dest = dir.path().join("out.yaml");
        extract_context(&src, "one", &dest).unwrap();
        assert_eq!(read_yaml(&dest)["current-context"], "one");
    }

    #[test]
    fn missing_context_is_invalid_input() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("config");
        std::fs::write(&src, CONFIG).unwrap();
        let dest = dir.path().join("out.yaml");
        let err = extract_context(&src, "nope", &dest).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidInput);
        assert!(err.message.contains("nope"), "{}", err.message);
        assert!(!dest.exists());
    }

    #[test]
    fn dangling_cluster_reference_is_invalid_input() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("config");
        std::fs::write(
            &src,
            r#"
users:
- { name: u1, user: { token: t } }
contexts:
- { name: one, context: { cluster: gone, user: u1 } }
"#,
        )
        .unwrap();
        let dest = dir.path().join("out.yaml");
        let err = extract_context(&src, "one", &dest).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidInput);
        assert!(err.message.contains("gone"), "{}", err.message);
    }

    #[test]
    fn invalid_source_yaml_is_invalid_input() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("config");
        std::fs::write(&src, "clusters: [unterminated").unwrap();
        let err = extract_context(&src, "one", &dir.path().join("out.yaml")).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidInput);
    }

    #[test]
    fn missing_source_is_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let err = extract_context(
            &dir.path().join("absent"),
            "one",
            &dir.path().join("out.yaml"),
        )
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
    }
}
