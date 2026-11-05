//! Cluster connections.

mod connect;
mod distribution;
mod manager;
mod state;

pub use connect::ConnectTimeouts;
pub use distribution::detect_distribution;
pub(crate) use manager::ClusterManager;
pub use manager::{ConnectionLogEntry, LogLevel};
pub use state::{ClusterInfo, ConnectionState, FailureKind};
