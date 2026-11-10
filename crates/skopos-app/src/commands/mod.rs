//! IPC commands. Each delegates to `AppCore`. They are async so that the file
//! writes behind them run off the main thread, which would otherwise freeze the UI.

pub mod actions;
pub mod argocd;
pub mod catalog;
pub mod cluster;
pub mod helm;
pub mod logs;
pub mod metrics;
pub mod portforward;
pub mod resources;
pub mod sessions;
pub mod settings;
pub mod tools;
