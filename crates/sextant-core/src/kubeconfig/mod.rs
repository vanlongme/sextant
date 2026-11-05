//! Kubeconfig discovery: parsing, default sources, the sync watcher and
//! per-context extraction.

mod extract;
mod parse;
mod sources;
mod sync;

pub use extract::extract_context;
pub use parse::{cluster_id, parse_contexts, ClusterId, ContextEntry};
pub use sources::{default_sources, SyncSource};
pub use sync::{KubeconfigSync, SyncSnapshot, SyncWarning};
