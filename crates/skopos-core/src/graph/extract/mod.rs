//! What the graph keeps of one object: its node's status and facts, its owner, labels and
//! selector, and the references it gives (spec E §4.4 to §4.6). Values are read leniently: a
//! field of another type than expected counts as absent, and nothing here panics.

mod workloads;

use std::collections::BTreeMap;

use serde_json::Value;

use super::kinds::Kind;
use super::types::{GraphRel, GraphStatus};

/// An object the graph points at.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) struct Target {
    pub kind: Kind,
    /// Empty for a cluster-scoped kind.
    pub namespace: String,
    pub name: String,
}

impl Target {
    pub(crate) fn id(&self) -> String {
        node_id(self.kind.name(), &self.namespace, &self.name)
    }
}

pub(crate) fn node_id(kind: &str, namespace: &str, name: &str) -> String {
    format!("{kind}/{namespace}/{name}")
}

/// An edge an object gives. `inbound` turns it around: the target points at the object.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Ref {
    pub rel: GraphRel,
    pub target: Target,
    pub inbound: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Item {
    pub kind: Kind,
    /// Empty for a cluster-scoped object.
    pub namespace: String,
    pub name: String,
    pub created: Option<String>,
    pub status: GraphStatus,
    pub status_text: Option<String>,
    pub facts: Vec<(String, String)>,
    /// The kind and name of the owner reference with `controller: true`.
    pub owner: Option<(String, String)>,
    pub labels: BTreeMap<String, String>,
    /// A Service's selector, when it has one that is not empty.
    pub selector: Option<BTreeMap<String, String>>,
    /// A Pod whose `Ready` condition is true.
    pub ready: bool,
    /// A ReplicaSet whose `spec.replicas` is 0.
    pub scaled_to_zero: bool,
    /// The load balancer addresses in front of this object.
    pub addresses: Vec<String>,
    pub refs: Vec<Ref>,
}

impl Item {
    pub(crate) fn id(&self) -> String {
        node_id(self.kind.name(), &self.namespace, &self.name)
    }

    pub(super) fn fact(&mut self, label: &str, value: impl Into<String>) {
        self.facts.push((label.to_owned(), value.into()));
    }

    /// A value the object lacks is left out.
    pub(super) fn fact_if(&mut self, label: &str, value: Option<String>) {
        if let Some(value) = value {
            self.fact(label, value);
        }
    }

    /// An outbound edge to `name` of `kind`, in this object's namespace unless the kind is
    /// cluster-scoped.
    pub(super) fn refer(&mut self, rel: GraphRel, kind: Kind, name: &str) {
        let namespace = if kind.namespaced() {
            self.namespace.clone()
        } else {
            String::new()
        };
        let target = Target {
            kind,
            namespace,
            name: name.to_owned(),
        };
        self.refer_to(rel, target, false);
    }

    /// Adds an edge once, however many fields give it.
    pub(super) fn refer_to(&mut self, rel: GraphRel, target: Target, inbound: bool) {
        let reference = Ref {
            rel,
            target,
            inbound,
        };
        if !self.refs.contains(&reference) {
            self.refs.push(reference);
        }
    }
}

/// A string at `pointer` that is not empty.
pub(super) fn text(value: &Value, pointer: &str) -> Option<String> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// An integer at `pointer`, or `default` when there is none.
pub(super) fn count(value: &Value, pointer: &str, default: i64) -> i64 {
    value
        .pointer(pointer)
        .and_then(Value::as_i64)
        .unwrap_or(default)
}

/// The array at `pointer`, or nothing.
pub(super) fn items<'a>(value: &'a Value, pointer: &str) -> &'a [Value] {
    value
        .pointer(pointer)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

/// A map of strings, such as labels. Entries whose value is not a string are left out.
pub(super) fn string_map(value: &Value) -> BTreeMap<String, String> {
    value.as_object().map_or_else(BTreeMap::new, |map| {
        map.iter()
            .filter_map(|(key, value)| Some((key.clone(), value.as_str()?.to_owned())))
            .collect()
    })
}

/// The status condition of type `kind`.
pub(super) fn condition<'a>(object: &'a Value, kind: &str) -> Option<&'a Value> {
    items(object, "/status/conditions")
        .iter()
        .find(|condition| condition["type"] == kind)
}

/// The values in their first order, without repeats.
pub(super) fn unique(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = Vec::new();
    for value in values {
        if !seen.contains(&value) {
            seen.push(value);
        }
    }
    seen
}

/// What a condition says. Unknown also stands for a condition that is absent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Said {
    True,
    /// With the condition's reason, when it has one.
    False(Option<String>),
    Unknown,
}

pub(super) fn said(condition: Option<&Value>) -> Said {
    let Some(condition) = condition else {
        return Said::Unknown;
    };
    match condition["status"].as_str() {
        Some("True") => Said::True,
        Some("False") => Said::False(text(condition, "/reason")),
        _ => Said::Unknown,
    }
}

fn controller(metadata: &Value) -> Option<(String, String)> {
    items(metadata, "/ownerReferences")
        .iter()
        .find(|owner| owner["controller"] == true)
        .and_then(|owner| Some((text(owner, "/kind")?, text(owner, "/name")?)))
}

/// The Item of a listed object of `kind`, or `None` when it has no name.
pub(crate) fn extract(kind: Kind, object: &Value) -> Option<Item> {
    let metadata = &object["metadata"];
    let name = text(metadata, "/name")?;
    let namespace = if kind.namespaced() {
        text(metadata, "/namespace").unwrap_or_default()
    } else {
        String::new()
    };
    let mut item = Item {
        kind,
        namespace,
        name,
        created: text(metadata, "/creationTimestamp"),
        status: GraphStatus::Neutral,
        status_text: None,
        facts: Vec::new(),
        owner: controller(metadata),
        labels: string_map(&metadata["labels"]),
        selector: None,
        ready: false,
        scaled_to_zero: false,
        addresses: Vec::new(),
        refs: Vec::new(),
    };
    match kind {
        Kind::Pod => workloads::pod(&mut item, object),
        Kind::Deployment => workloads::deployment(&mut item, object),
        Kind::StatefulSet => workloads::stateful_set(&mut item, object),
        Kind::DaemonSet => workloads::daemon_set(&mut item, object),
        Kind::ReplicaSet => workloads::replica_set(&mut item, object),
        Kind::Job => workloads::job(&mut item, object),
        Kind::CronJob => workloads::cron_job(&mut item, object),
        // Task 4 replaces this arm with the other nine kinds.
        _ => {}
    }
    Some(item)
}

#[cfg(test)]
pub(super) mod test_support {
    use serde_json::Value;

    use super::{extract, Item};
    use crate::graph::kinds::Kind;
    use crate::graph::types::GraphRel;

    pub(crate) fn item(kind: Kind, object: Value) -> Item {
        extract(kind, &object).expect("the object has a name")
    }

    pub(crate) fn facts(item: &Item) -> Vec<(&str, &str)> {
        item.facts
            .iter()
            .map(|(label, value)| (label.as_str(), value.as_str()))
            .collect()
    }

    /// Each reference as `(rel, target id, inbound)`.
    pub(crate) fn refs(item: &Item) -> Vec<(GraphRel, String, bool)> {
        item.refs
            .iter()
            .map(|r| (r.rel, r.target.id(), r.inbound))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::test_support::item;
    use super::*;

    #[test]
    fn the_common_fields_come_from_the_metadata() {
        let item = item(
            Kind::Deployment,
            json!({ "metadata": {
                "name": "web",
                "namespace": "a",
                "creationTimestamp": "2026-11-12T08:00:00Z",
                "labels": { "app": "web", "odd": 5 },
                "ownerReferences": [
                    { "kind": "Other", "name": "x" },
                    { "kind": "Thing", "name": "t", "controller": true },
                ],
            } }),
        );
        assert_eq!(item.id(), "Deployment/a/web");
        assert_eq!(item.created.as_deref(), Some("2026-11-12T08:00:00Z"));
        assert_eq!(item.owner, Some(("Thing".to_owned(), "t".to_owned())));
        assert_eq!(
            item.labels,
            BTreeMap::from([("app".to_owned(), "web".to_owned())])
        );
    }

    #[test]
    fn an_object_without_a_name_is_skipped() {
        assert!(extract(Kind::Pod, &json!({ "metadata": {} })).is_none());
        assert!(extract(Kind::Pod, &json!(null)).is_none());
    }

    #[test]
    fn a_cluster_scoped_kind_has_no_namespace() {
        let item = item(
            Kind::GatewayClass,
            json!({ "metadata": { "name": "c", "namespace": "x" } }),
        );
        assert_eq!(item.id(), "GatewayClass//c");
    }

    #[test]
    fn conditions_say_true_false_or_unknown() {
        assert_eq!(said(Some(&json!({ "status": "True" }))), Said::True);
        assert_eq!(
            said(Some(&json!({ "status": "False", "reason": "Bad" }))),
            Said::False(Some("Bad".into()))
        );
        assert_eq!(said(Some(&json!({ "status": "False" }))), Said::False(None));
        assert_eq!(said(Some(&json!({ "status": "Unknown" }))), Said::Unknown);
        assert_eq!(said(None), Said::Unknown);
    }
}
