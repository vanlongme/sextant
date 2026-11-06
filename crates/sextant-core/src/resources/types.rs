//! Types describing a served API resource and the events of a watch on one.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Identifies one resource type by group, version and plural.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ResourceRef {
    pub group: String,
    pub version: String,
    pub plural: String,
    pub kind: String,
    pub namespaced: bool,
}

/// A served resource with what the current user may do with it.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ApiResourceInfo {
    pub resource: ResourceRef,
    pub verbs: Vec<String>,
    pub short_names: Vec<String>,
    pub can_list: bool,
    pub can_watch: bool,
    pub can_create: bool,
    pub can_update: bool,
    pub can_patch: bool,
    pub can_delete: bool,
}

/// Identifies one object within a resource type.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ObjectKey {
    pub namespace: Option<String>,
    pub name: String,
}

/// The health of a watch. `NotServed` and `Forbidden` are final: nothing more
/// arrives on that subscription.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum WatchStatus {
    Syncing,
    Live,
    Reconnecting,
    NotServed,
    Forbidden,
}

/// What a subscriber receives. A `Snapshot` replaces everything it holds, and a
/// `Batch` changes it.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum WatchEvent {
    Snapshot {
        items: Vec<serde_json::Value>,
    },
    Batch {
        upserts: Vec<serde_json::Value>,
        deletes: Vec<ObjectKey>,
    },
    Status {
        status: WatchStatus,
        message: Option<String>,
    },
}
