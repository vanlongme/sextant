//! What the graph sends to the interface (spec E §4.3 to §4.5).

use serde::Serialize;
use ts_rs::TS;

/// How a node is doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum GraphStatus {
    Nominal,
    Warning,
    Critical,
    Neutral,
}

/// What an edge means. It points from the first object named to the second.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum GraphRel {
    Owns,
    Selects,
    Routes,
    Mounts,
    Env,
    RunsAs,
    Claims,
    Class,
}

/// An object, a referenced object that does not exist, or a load balancer address. `id` is
/// `‹Kind›/‹namespace›/‹name›`, with an empty namespace for cluster-scoped objects. `kind` is the
/// Kubernetes kind, or `LoadBalancer`. `created` is the `creationTimestamp`. `facts` are
/// `[label, value]` pairs in the order spec E §4.6 gives. Fields carry no doc comments, so the
/// generated type stays on one line.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub id: String,
    pub kind: String,
    pub group: String,
    pub plural: String,
    pub namespace: String,
    pub name: String,
    pub created: Option<String>,
    pub status: GraphStatus,
    pub status_text: Option<String>,
    pub facts: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, TS)]
#[ts(export)]
pub struct GraphEdge {
    pub from: String,
    pub to: String,
    pub rel: GraphRel,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct GraphNamespaceCount {
    pub namespace: String,
    pub nodes: u32,
}

/// What a subscriber receives. A snapshot replaces everything it holds: `counts` gives every
/// namespace of the whole graph with its node count, by name, and `missing` the plurals of the
/// kinds that could not be listed. A failure is the subscription's last event.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum GraphEvent {
    Snapshot {
        nodes: Vec<GraphNode>,
        edges: Vec<GraphEdge>,
        counts: Vec<GraphNamespaceCount>,
        missing: Vec<String>,
        #[serde(rename = "gatewayApi")]
        gateway_api: bool,
    },
    Failure {
        message: String,
    },
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn events_serialize_as_the_interface_reads_them() {
        let event = GraphEvent::Snapshot {
            nodes: vec![GraphNode {
                id: "Pod/a/web".into(),
                kind: "Pod".into(),
                group: String::new(),
                plural: "pods".into(),
                namespace: "a".into(),
                name: "web".into(),
                created: None,
                status: GraphStatus::Nominal,
                status_text: Some("Running".into()),
                facts: vec![("Ready".into(), "1/1".into())],
            }],
            edges: vec![GraphEdge {
                from: "Pod/a/web".into(),
                to: "ServiceAccount/a/web".into(),
                rel: GraphRel::RunsAs,
            }],
            counts: vec![GraphNamespaceCount {
                namespace: "a".into(),
                nodes: 1,
            }],
            missing: vec!["secrets".into()],
            gateway_api: true,
        };
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            json!({
                "type": "snapshot",
                "nodes": [{
                    "id": "Pod/a/web", "kind": "Pod", "group": "", "plural": "pods",
                    "namespace": "a", "name": "web", "created": null, "status": "nominal",
                    "statusText": "Running", "facts": [["Ready", "1/1"]],
                }],
                "edges": [{ "from": "Pod/a/web", "to": "ServiceAccount/a/web", "rel": "runsAs" }],
                "counts": [{ "namespace": "a", "nodes": 1 }],
                "missing": ["secrets"],
                "gatewayApi": true,
            })
        );
        assert_eq!(
            serde_json::to_value(GraphEvent::Failure {
                message: "m".into()
            })
            .unwrap(),
            json!({ "type": "failure", "message": "m" })
        );
    }
}
