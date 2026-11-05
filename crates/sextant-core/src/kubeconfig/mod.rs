//! Kubeconfig discovery: parsing, default sources, the sync watcher and
//! per-context extraction.

mod extract;
mod parse;
mod sources;
mod sync;

pub use extract::extract_context;
pub(crate) use extract::write_private;
pub use parse::{cluster_id, parse_contexts, ClusterId, ContextEntry};
pub(crate) use parse::{strip_bom, yaml_error_text};
pub use sources::{default_sources, SyncSource};
pub(crate) use sync::MAX_FILE_BYTES;
pub use sync::{KubeconfigSync, SyncSnapshot, SyncWarning};
