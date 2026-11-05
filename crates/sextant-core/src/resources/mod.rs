//! The resource engine: what a cluster serves, and what the user may do with it.

mod access;
mod discovery;
mod types;

pub use types::{ApiResourceInfo, ResourceRef};
