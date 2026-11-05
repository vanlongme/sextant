use serde::Serialize;
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", tag = "status")]
#[ts(export)]
pub enum ConnectionState {
    Disconnected,
    Connecting,
    Connected { info: ClusterInfo },
    Failed { kind: FailureKind, message: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum FailureKind {
    Unreachable,
    Unauthorized,
    Forbidden,
    ConfigInvalid,
    Other,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ClusterInfo {
    pub version: String,
    pub distribution: String,
    pub node_count: Option<u32>,
    pub namespaces: Vec<String>,
    pub namespaces_restricted: bool,
    pub is_admin: bool,
}
