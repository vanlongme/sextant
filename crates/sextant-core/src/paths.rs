use std::path::{Path, PathBuf};

use crate::error::{CoreResult, ErrorCode, IpcError};

#[derive(Clone, Debug)]
pub struct AppPaths {
    pub config: PathBuf,
    pub data: PathBuf,
    pub logs: PathBuf,
    pub cache: PathBuf,
    pub home: PathBuf,
}

impl AppPaths {
    /// `SEXTANT_CONFIG_DIR` (when set and non-empty) roots everything; otherwise
    /// the platform directories for qualifier `dev.sextant` are used.
    pub fn resolve() -> CoreResult<AppPaths> {
        let home = directories::BaseDirs::new()
            .map(|d| d.home_dir().to_path_buf())
            .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
            .ok_or_else(|| IpcError::new(ErrorCode::Internal, "cannot determine home directory"))?;
        if let Some(root) = std::env::var_os("SEXTANT_CONFIG_DIR").filter(|v| !v.is_empty()) {
            return Ok(Self::under(Path::new(&root), &home));
        }
        let dirs =
            directories::ProjectDirs::from("dev", "sextant", "Sextant").ok_or_else(|| {
                IpcError::new(
                    ErrorCode::Internal,
                    "cannot determine application directories",
                )
            })?;
        let data = dirs.data_dir().to_path_buf();
        Ok(AppPaths {
            config: dirs.config_dir().to_path_buf(),
            logs: data.join("logs"),
            data,
            cache: dirs.cache_dir().to_path_buf(),
            home,
        })
    }

    /// Layout used by tests and `SEXTANT_CONFIG_DIR`; creates nothing.
    pub fn under(root: &Path, home: &Path) -> AppPaths {
        AppPaths {
            config: root.join("config"),
            data: root.join("data"),
            logs: root.join("logs"),
            cache: root.join("cache"),
            home: home.to_path_buf(),
        }
    }

    pub fn ensure_dirs(&self) -> CoreResult<()> {
        for dir in [&self.config, &self.data, &self.logs, &self.cache] {
            std::fs::create_dir_all(dir).map_err(|e| {
                let mut err = IpcError::from(e);
                // Shown to the user when the app cannot start, where the bare OS error says too little.
                err.message = format!("cannot create {}: {}", dir.display(), err.message);
                err
            })?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn under_creates_nothing_and_ensure_dirs_creates_all() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let p = AppPaths::under(&root.path().join("r"), &home);
        assert!(!p.config.exists());
        p.ensure_dirs().unwrap();
        assert!(p.config.is_dir() && p.data.is_dir() && p.logs.is_dir() && p.cache.is_dir());
        assert_eq!(p.home, home);
    }

    #[test]
    fn ensure_dirs_failure_names_the_directory() {
        let root = tempfile::tempdir().unwrap();
        let blocker = root.path().join("file");
        std::fs::write(&blocker, "").unwrap();
        let p = AppPaths::under(&blocker, root.path());

        let err = p.ensure_dirs().unwrap_err();

        assert!(err.message.contains("config"), "{}", err.message);
    }

    #[test]
    fn env_override_roots_everything() {
        let root = tempfile::tempdir().unwrap();
        // Only test in this crate touching SEXTANT_CONFIG_DIR.
        std::env::set_var("SEXTANT_CONFIG_DIR", root.path());
        let p = AppPaths::resolve().unwrap();
        std::env::remove_var("SEXTANT_CONFIG_DIR");
        assert!(p.config.starts_with(root.path()));
        assert!(p.data.starts_with(root.path()));
        assert!(p.logs.starts_with(root.path()));
        assert!(p.cache.starts_with(root.path()));
    }
}
