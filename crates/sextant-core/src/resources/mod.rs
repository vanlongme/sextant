//! The resource engine: what a cluster serves, and what the user may do with it.

mod access;
mod apply;
mod discovery;
mod hub;
mod ops;
mod sanitize;
mod types;

pub use apply::ApplyResult;
pub(crate) use hub::WatchHub;
pub use ops::{InvolvedRef, Propagation};
pub use sanitize::strip_for_list;
pub use types::{ApiResourceInfo, ObjectKey, ResourceRef, WatchEvent, WatchStatus};
