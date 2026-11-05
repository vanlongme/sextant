//! Types describing a served API resource.

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
    pub can_delete: bool,
}
