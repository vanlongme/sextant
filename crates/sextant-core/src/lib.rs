pub mod app_core;
pub mod catalog;
pub mod cluster;
pub mod error;
pub mod kubeconfig;
pub mod paths;
pub mod prefs;
pub mod shell_env;
pub mod store;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(test)]
mod tests {
    #[test]
    fn version_is_set() {
        assert!(!super::VERSION.is_empty());
    }
}
