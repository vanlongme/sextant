pub mod app_core;
pub mod catalog;
pub mod cluster;
pub mod error;
pub mod external_url;
pub mod helm;
pub mod kubeconfig;
pub mod metrics;
pub mod paths;
pub mod portforward;
pub mod prefs;
pub mod process;
pub mod resources;
pub mod sessions;
pub mod shell_env;
pub mod store;
pub mod tools;
pub mod ui_state;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(test)]
mod tests {
    #[test]
    fn version_is_set() {
        assert!(!super::VERSION.is_empty());
    }
}
