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
    /// `SKOPOS_CONFIG_DIR` (when set and non-empty) roots everything; otherwise
    /// the platform directories for qualifier `dev.skopos` are used.
    pub fn resolve() -> CoreResult<AppPaths> {
        let override_root = std::env::var_os("SKOPOS_CONFIG_DIR").filter(|v| !v.is_empty());
        // `directories` ignores USERPROFILE on Windows, so a test home must come from the env.
        let env_home = || {
            let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
            std::env::var_os(var)
                .filter(|v| !v.is_empty())
                .or_else(|| std::env::var_os("HOME").filter(|v| !v.is_empty()))
                .map(PathBuf::from)
        };
        let base_home = || directories::BaseDirs::new().map(|d| d.home_dir().to_path_buf());
        let home = if override_root.is_some() {
            env_home().or_else(base_home)
        } else {
            base_home().or_else(env_home)
        }
        .ok_or_else(|| IpcError::new(ErrorCode::Internal, "cannot determine home directory"))?;
        if let Some(root) = override_root {
            return Ok(Self::under(Path::new(&root), &home));
        }
        let dirs =
            directories::ProjectDirs::from("dev", "skopos", "SkoposIDE").ok_or_else(|| {
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

    /// Layout used by tests and `SKOPOS_CONFIG_DIR`; creates nothing.
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
        // Only test in this crate touching SKOPOS_CONFIG_DIR.
        std::env::set_var("SKOPOS_CONFIG_DIR", root.path());
        let p = AppPaths::resolve().unwrap();
        std::env::remove_var("SKOPOS_CONFIG_DIR");
        assert!(p.config.starts_with(root.path()));
        assert!(p.data.starts_with(root.path()));
        assert!(p.logs.starts_with(root.path()));
        assert!(p.cache.starts_with(root.path()));
    }
}
