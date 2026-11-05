//! The resource engine: what a cluster serves, and what the user may do with it.

mod access;
mod discovery;
mod hub;
mod sanitize;
mod types;

pub(crate) use hub::WatchHub;
pub use sanitize::strip_for_list;
pub use types::{ApiResourceInfo, ObjectKey, ResourceRef, WatchEvent, WatchStatus};
