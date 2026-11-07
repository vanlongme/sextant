//! The resource engine: what a cluster serves, and what the user may do with it.

mod access;
mod actions;
mod apply;
mod discovery;
mod drain;
mod hub;
mod ops;
mod sanitize;
mod service_account;
mod types;

pub use actions::{DataChange, SecretValue};
pub use apply::ApplyResult;
pub(crate) use drain::RunningDrain;
pub use drain::{DrainEvent, DrainOptions, DrainOutcome, PodRef, SkipReason, SkippedPod};
pub(crate) use hub::WatchHub;
pub(crate) use ops::{invalid, is_path_segment};
pub use ops::{InvolvedRef, Propagation};
pub use sanitize::strip_for_list;
pub use service_account::SavedKubeconfig;
pub use types::{ApiResourceInfo, ObjectKey, ResourceRef, Row, WatchEvent, WatchStatus};
