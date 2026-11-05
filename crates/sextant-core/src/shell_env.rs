use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

fn find(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() || from > haystack.len() {
        return None;
    }
    haystack[from..]
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|i| i + from)
}

/// Extracts the NUL-separated `env -0` block found between two `marker`s.
/// Anything outside the markers (shell rc noise) is ignored.
pub fn parse_env_block(raw: &[u8], marker: &str) -> Option<HashMap<String, String>> {
    let m = marker.as_bytes();
    let start = find(raw, m, 0)? + m.len();
    // The shell may export the marker itself (`$_` holds the last argument of
    // the previous command), so the closing marker is the last occurrence.
    let mut end = find(raw, m, start)?;
    while let Some(next) = find(raw, m, end + m.len()) {
        end = next;
    }
    let mut env = HashMap::new();
    for entry in raw[start..end].split(|b| *b == 0) {
        if entry.is_empty() {
            continue;
        }
        let text = String::from_utf8_lossy(entry);
        if let Some((k, v)) = text.split_once('=') {
            if !k.is_empty() {
                env.insert(k.to_string(), v.to_string());
            }
        }
    }
    Some(env)
}

/// Runs `<shell> -ilc "printf MARK; env -0; printf MARK"` and returns the environment.
pub fn load_from_shell(shell: &Path, timeout: Duration) -> Result<HashMap<String, String>, String> {
    use std::io::Read;
    use std::process::{Command, Stdio};

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let marker = format!("SEXTANT_ENV_{}_{}", std::process::id(), nanos);
    let script = format!("printf {marker}; env -0; printf {marker}");

    let mut child = Command::new(shell)
        .arg("-ilc")
        .arg(&script)
        .env("DISABLE_AUTO_UPDATE", "true")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("cannot start {}: {e}", shell.display()))?;

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "cannot capture shell output".to_string())?;
    let (tx, rx) = std::sync::mpsc::channel();
    // Detached on purpose: if the shell leaves grandchildren holding the pipe open,
    // we must not block on joining this thread.
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        let _ = tx.send(buf);
    });

    match rx.recv_timeout(timeout) {
        Ok(buf) => {
            let _ = child.wait();
            parse_env_block(&buf, &marker)
                .ok_or_else(|| "shell output did not contain the environment block".to_string())
        }
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(format!(
                "{} did not finish within {} ms",
                shell.display(),
                timeout.as_millis()
            ))
        }
    }
}

/// Merges the login shell's environment into this process. No-op on Windows.
pub fn apply_login_shell_env() {
    #[cfg(not(windows))]
    {
        let Some(shell) = std::env::var_os("SHELL").filter(|s| !s.is_empty()) else {
            tracing::warn!("SHELL is not set; keeping the inherited environment");
            return;
        };
        match load_from_shell(Path::new(&shell), Duration::from_secs(5)) {
            Ok(env) => {
                for (k, v) in env {
                    if matches!(k.as_str(), "PWD" | "OLDPWD" | "SHLVL" | "_") {
                        continue;
                    }
                    std::env::set_var(k, v);
                }
            }
            Err(e) => tracing::warn!("could not load login shell environment: {e}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_env_block_extracts_between_markers() {
        let raw = b"noise from rc files\nMARK\0PATH=/a:/b\0HOME=/h\0MULTI=x\ny\0MARK\0trailing";
        let env = parse_env_block(raw, "MARK").unwrap();
        assert_eq!(env["PATH"], "/a:/b");
        assert_eq!(env["MULTI"], "x\ny");
        assert_eq!(env.len(), 3);
    }

    #[test]
    fn parse_env_block_tolerates_marker_inside_values() {
        let raw = b"MARK\0A=1\0_=printf MARK\0PATH=/a\0MARK";
        let env = parse_env_block(raw, "MARK").unwrap();
        assert_eq!(env["PATH"], "/a");
        assert_eq!(env["A"], "1");
    }

    #[test]
    fn parse_env_block_without_markers_is_none() {
        assert!(parse_env_block(b"PATH=/a", "MARK").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn hanging_shell_times_out() {
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("sh");
        std::fs::write(&fake, "#!/bin/sh\nsleep 30\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let started = std::time::Instant::now();
        assert!(load_from_shell(&fake, std::time::Duration::from_millis(300)).is_err());
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
    }

    #[cfg(unix)]
    #[test]
    fn real_shell_returns_environment() {
        let env = load_from_shell(Path::new("/bin/sh"), Duration::from_secs(5)).unwrap();
        assert!(env.contains_key("PATH"));
    }
}
