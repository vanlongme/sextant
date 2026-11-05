use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tokio::sync::watch;
use ts_rs::TS;

use crate::error::{CoreResult, ErrorCode, IpcError};

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StoreWarning {
    pub file: String,
    pub message: String,
}

#[derive(Deserialize)]
struct Envelope {
    version: u32,
    data: serde_json::Value,
}

#[derive(Serialize)]
struct EnvelopeRef<'a, T> {
    version: u32,
    data: &'a T,
}

/// A versioned JSON file with atomic writes and change subscription.
pub struct JsonStore<T> {
    path: PathBuf,
    version: u32,
    state: Mutex<T>,
    tx: watch::Sender<T>,
}

fn unix_ts() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn file_label(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

/// Moves a file we cannot use aside so it is never overwritten or lost.
fn set_aside(path: &Path, kind: &str) -> String {
    let mut target = path.as_os_str().to_owned();
    target.push(format!(".{kind}-{}", unix_ts()));
    let target = PathBuf::from(target);
    match std::fs::rename(path, &target) {
        Ok(()) => format!("moved to {}", file_label(&target)),
        Err(e) => format!("could not be moved aside ({e})"),
    }
}

impl<T> JsonStore<T>
where
    T: Serialize + DeserializeOwned + Default + Clone + Send + Sync + 'static,
{
    pub fn open(path: PathBuf, version: u32) -> (Self, Option<StoreWarning>) {
        let (value, warning) = Self::load(&path, version);
        let (tx, _rx) = watch::channel(value.clone());
        (
            Self {
                path,
                version,
                state: Mutex::new(value),
                tx,
            },
            warning,
        )
    }

    fn load(path: &Path, version: u32) -> (T, Option<StoreWarning>) {
        let label = file_label(path);
        let warn = |message: String| StoreWarning {
            file: label.clone(),
            message,
        };
        let bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return (T::default(), None),
            Err(e) => {
                let moved = set_aside(path, "unreadable");
                return (
                    T::default(),
                    Some(warn(format!("{label} could not be read ({e}); {moved}"))),
                );
            }
        };
        let envelope: Envelope = match serde_json::from_slice(&bytes) {
            Ok(env) => env,
            Err(e) => {
                let moved = set_aside(path, "corrupt");
                return (
                    T::default(),
                    Some(warn(format!("{label} is not valid ({e}); {moved}"))),
                );
            }
        };
        if envelope.version > version {
            let moved = set_aside(path, "newer");
            return (
                T::default(),
                Some(warn(format!(
                    "{label} was written by a newer version ({}); {moved}",
                    envelope.version
                ))),
            );
        }
        match serde_json::from_value::<T>(envelope.data) {
            Ok(v) => (v, None),
            Err(e) => {
                let moved = set_aside(path, "corrupt");
                (
                    T::default(),
                    Some(warn(format!(
                        "{label} has unexpected content ({e}); {moved}"
                    ))),
                )
            }
        }
    }

    pub fn get(&self) -> T {
        self.lock().clone()
    }

    pub fn update(&self, f: impl FnOnce(&mut T)) -> CoreResult<T> {
        let mut guard = self.lock();
        let mut next = guard.clone();
        f(&mut next);
        self.write(&next)?;
        *guard = next.clone();
        self.tx.send_replace(next.clone());
        Ok(next)
    }

    pub fn subscribe(&self) -> watch::Receiver<T> {
        self.tx.subscribe()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, T> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn write(&self, value: &T) -> CoreResult<()> {
        let dir = self
            .path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        std::fs::create_dir_all(dir)?;
        let bytes = serde_json::to_vec_pretty(&EnvelopeRef {
            version: self.version,
            data: value,
        })
        .map_err(|e| IpcError::new(ErrorCode::Internal, format!("cannot serialize: {e}")))?;
        let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tmp.as_file()
                .set_permissions(std::fs::Permissions::from_mode(0o600))?;
        }
        tmp.write_all(&bytes)?;
        tmp.as_file().sync_all()?;
        tmp.persist(&self.path).map_err(|e| e.error)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default, Clone, Serialize, Deserialize, PartialEq, Debug)]
    struct Sample {
        n: u32,
    }

    #[test]
    fn missing_file_gives_default_without_warning() {
        let dir = tempfile::tempdir().unwrap();
        let (s, w) = JsonStore::<Sample>::open(dir.path().join("a.json"), 1);
        assert!(w.is_none());
        assert_eq!(s.get(), Sample::default());
    }

    #[test]
    fn update_persists_atomically_and_reloads() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.json");
        let (s, _) = JsonStore::<Sample>::open(p.clone(), 1);
        s.update(|v| v.n = 7).unwrap();
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(
            names,
            vec![std::ffi::OsString::from("a.json")],
            "no temp files left behind"
        );
        let (again, _) = JsonStore::<Sample>::open(p, 1);
        assert_eq!(again.get().n, 7);
    }

    #[test]
    fn corrupt_file_is_preserved_and_defaults_used() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.json");
        std::fs::write(&p, "{ not json").unwrap();
        let (s, w) = JsonStore::<Sample>::open(p.clone(), 1);
        assert_eq!(s.get(), Sample::default());
        assert!(w.unwrap().message.contains("a.json"));
        let kept = std::fs::read_dir(dir.path())
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with("a.json.corrupt-")
            })
            .count();
        assert_eq!(kept, 1);
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_file_is_preserved_and_defaults_used() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.json");
        let saved = r#"{"version":1,"data":{"n":5}}"#;
        std::fs::write(&p, saved).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::read(&p).is_ok() {
            eprintln!("skipped: root ignores file modes");
            return;
        }

        let (s, w) = JsonStore::<Sample>::open(p.clone(), 1);

        assert_eq!(s.get(), Sample::default());
        let message = w.unwrap().message;
        assert!(message.contains("moved to a.json.unreadable-"), "{message}");
        assert!(!p.exists());
        s.update(|v| v.n = 9).unwrap();
        let kept = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().path())
            .find(|path| path.to_string_lossy().contains("a.json.unreadable-"))
            .unwrap();
        std::fs::set_permissions(&kept, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(std::fs::read_to_string(kept).unwrap(), saved);
    }

    #[test]
    fn newer_version_is_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.json");
        std::fs::write(&p, r#"{"version":99,"data":{"n":5}}"#).unwrap();
        let (s, w) = JsonStore::<Sample>::open(p, 1);
        assert_eq!(s.get(), Sample::default());
        assert!(w.is_some());
        let kept = std::fs::read_dir(dir.path())
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with("a.json.newer-")
            })
            .count();
        assert_eq!(kept, 1);
    }

    #[test]
    fn subscribers_see_updates() {
        let dir = tempfile::tempdir().unwrap();
        let (s, _) = JsonStore::<Sample>::open(dir.path().join("a.json"), 1);
        let rx = s.subscribe();
        s.update(|v| v.n = 3).unwrap();
        assert_eq!(rx.borrow().n, 3);
    }

    #[cfg(unix)]
    #[test]
    fn file_mode_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.json");
        let (s, _) = JsonStore::<Sample>::open(p.clone(), 1);
        s.update(|v| v.n = 1).unwrap();
        let mode = std::fs::metadata(&p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn failed_write_keeps_old_value() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.json");
        let (s, _) = JsonStore::<Sample>::open(p.clone(), 1);
        // The target path is now a directory, so persist (rename over it) fails.
        std::fs::create_dir(&p).unwrap();
        std::fs::write(p.join("x"), "x").unwrap();
        assert!(s.update(|v| v.n = 9).is_err());
        assert_eq!(s.get(), Sample::default());
    }
}
