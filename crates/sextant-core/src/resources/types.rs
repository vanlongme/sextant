//! Types describing a served API resource and the events of a watch on one.

use std::sync::Arc;

use serde::{Deserialize, Serialize, Serializer};
use serde_json::value::RawValue;
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

/// One watched object, kept as the JSON text it crosses to the webview as. Parsed,
/// an object costs about ten times its text, and the hub never reads inside one.
/// Clones share the text.
#[derive(Debug, Clone)]
pub struct Row(Arc<RawValue>);

impl Row {
    pub fn new(object: &serde_json::Value) -> serde_json::Result<Self> {
        serde_json::value::to_raw_value(object).map(|raw| Self(raw.into()))
    }

    pub fn json(&self) -> &str {
        self.0.get()
    }

    /// Parses the text again, for a reader that needs the fields.
    pub fn to_value(&self) -> serde_json::Value {
        serde_json::from_str(self.0.get()).expect("a row holds the JSON of a value")
    }
}

/// Writes the text as it is, so the object reaches the webview unchanged.
impl Serialize for Row {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}

/// What a subscriber receives. A `Snapshot` replaces everything it holds, and a
/// `Batch` changes it.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum WatchEvent {
    Snapshot {
        #[ts(as = "Vec<serde_json::Value>")]
        items: Vec<Row>,
    },
    Batch {
        #[ts(as = "Vec<serde_json::Value>")]
        upserts: Vec<Row>,
        deletes: Vec<ObjectKey>,
    },
    Status {
        status: WatchStatus,
        message: Option<String>,
    },
}
