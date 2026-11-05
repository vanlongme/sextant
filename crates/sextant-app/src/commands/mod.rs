//! IPC commands. Each delegates to `AppCore`. They are async so that the file
//! writes behind them run off the main thread, which would otherwise freeze the UI.

pub mod catalog;
pub mod cluster;
pub mod settings;
