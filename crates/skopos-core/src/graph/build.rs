//! The whole graph from what the store holds (spec E §4.4 to §4.6), and one subscription's view
//! of it (§4.7).

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use super::extract::{extract, node_id, Item, Target};
use super::kinds::Kind;
use super::types::{GraphEdge, GraphEvent, GraphNamespaceCount, GraphNode, GraphRel, GraphStatus};
use crate::resources::{WatchEvent, WatchStatus};

const LOAD_BALANCER: &str = "LoadBalancer";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    /// Its first list has not finished.
    Waiting,
    Listed,
    /// Forbidden, or no longer served.
    Missing,
}

struct KindState {
    phase: Phase,
    /// Keyed by namespace and name.
    objects: HashMap<(String, String), Item>,
}

/// What the graph has read of each kind it reads.
pub(crate) struct Store {
    kinds: BTreeMap<Kind, KindState>,
}

fn key(item: &Item) -> (String, String) {
    (item.namespace.clone(), item.name.clone())
}

impl Store {
    /// `kinds` are the kinds the cluster serves. The others are never read.
    pub(crate) fn new(kinds: &[Kind]) -> Self {
        let kinds = kinds
            .iter()
            .map(|kind| {
                let state = KindState {
                    phase: Phase::Waiting,
                    objects: HashMap::new(),
                };
                (*kind, state)
            })
            .collect();
        Self { kinds }
    }

    /// Every kind has finished its first list, or cannot be listed (spec E §4.3).
    pub(crate) fn ready(&self) -> bool {
        self.kinds
            .values()
            .all(|state| state.phase != Phase::Waiting)
    }

    pub(crate) fn apply(&mut self, kind: Kind, event: WatchEvent) {
        let Some(state) = self.kinds.get_mut(&kind) else {
            return;
        };
        match event {
            WatchEvent::Snapshot { items } => {
                state.objects = items
                    .iter()
                    .filter_map(|row| extract(kind, &row.to_value()))
                    .map(|item| (key(&item), item))
                    .collect();
                state.phase = Phase::Listed;
            }
            WatchEvent::Batch { upserts, deletes } => {
                for row in &upserts {
                    if let Some(item) = extract(kind, &row.to_value()) {
                        state.objects.insert(key(&item), item);
                    }
                }
                for deleted in deletes {
                    let namespace = if kind.namespaced() {
                        deleted.namespace.unwrap_or_default()
                    } else {
                        String::new()
                    };
                    state.objects.remove(&(namespace, deleted.name));
                }
            }
            // Both are final: the hub sends nothing more for this kind.
            WatchEvent::Status {
                status: WatchStatus::Forbidden | WatchStatus::NotServed,
                ..
            } => {
                state.objects.clear();
                state.phase = Phase::Missing;
            }
            WatchEvent::Status { .. } => {}
        }
    }

    fn items(&self, kind: Kind) -> impl Iterator<Item = &Item> {
        self.kinds
            .get(&kind)
            .into_iter()
            .flat_map(|state| state.objects.values())
    }

    fn get(&self, target: &Target) -> Option<&Item> {
        self.kinds
            .get(&target.kind)?
            .objects
            .get(&(target.namespace.clone(), target.name.clone()))
    }

    /// Listed. A kind that is forbidden, gone or not served is not.
    fn listable(&self, kind: Kind) -> bool {
        self.kinds
            .get(&kind)
            .is_some_and(|state| state.phase == Phase::Listed)
    }

    /// The plurals of the kinds that could not be listed, by name.
    fn missing(&self) -> Vec<String> {
        let mut missing: Vec<String> = self
            .kinds
            .iter()
            .filter(|(_, state)| state.phase == Phase::Missing)
            .map(|(kind, _)| kind.plural().to_owned())
            .collect();
        missing.sort();
        missing
    }

    /// Spec E §4.3: any of the three Gateway API kinds is served at `v1`.
    fn gateway_api(&self) -> bool {
        self.kinds.keys().any(|kind| kind.is_gateway_api())
    }
}

/// The whole graph, as the builder publishes it. Nodes are sorted by id, edges by
/// (from, to, rel).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Built {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub counts: Vec<GraphNamespaceCount>,
    pub missing: Vec<String>,
    pub gateway_api: bool,
}

fn edge(from: &str, to: &str, rel: GraphRel) -> GraphEdge {
    GraphEdge {
        from: from.to_owned(),
        to: to.to_owned(),
        rel,
    }
}

fn node_of(item: &Item) -> GraphNode {
    GraphNode {
        id: item.id(),
        kind: item.kind.name().to_owned(),
        group: item.kind.group().to_owned(),
        plural: item.kind.plural().to_owned(),
        namespace: item.namespace.clone(),
        name: item.name.clone(),
        created: item.created.clone(),
        status: item.status,
        status_text: item.status_text.clone(),
        facts: item.facts.clone(),
    }
}

/// A referenced object that does not exist (spec E §4.4). "Not found" only when its kind is
/// listed, since otherwise the graph cannot tell.
fn absent(target: &Target, listable: bool) -> GraphNode {
    let (status, status_text) = if listable {
        (GraphStatus::Critical, Some("Not found".to_owned()))
    } else {
        (GraphStatus::Neutral, None)
    };
    GraphNode {
        id: target.id(),
        kind: target.kind.name().to_owned(),
        group: target.kind.group().to_owned(),
        plural: target.kind.plural().to_owned(),
        namespace: target.namespace.clone(),
        name: target.name.clone(),
        created: None,
        status,
        status_text,
        facts: Vec::new(),
    }
}

fn load_balancer(address: &str) -> GraphNode {
    GraphNode {
        id: node_id(LOAD_BALANCER, "", address),
        kind: LOAD_BALANCER.to_owned(),
        group: String::new(),
        plural: String::new(),
        namespace: String::new(),
        name: address.to_owned(),
        created: None,
        status: GraphStatus::Neutral,
        status_text: None,
        facts: vec![("Address".to_owned(), address.to_owned())],
    }
}

/// The whole graph (spec E §4.4 to §4.6).
pub(crate) fn build(store: &Store) -> Built {
    let mut pods_by_namespace: HashMap<&str, Vec<&Item>> = HashMap::new();
    let mut pod_owners = HashSet::new();
    for pod in store.items(Kind::Pod) {
        pods_by_namespace
            .entry(pod.namespace.as_str())
            .or_default()
            .push(pod);
        if let Some((kind, name)) = &pod.owner {
            pod_owners.insert(node_id(kind, &pod.namespace, name));
        }
    }

    // Every object of a kind that is always shown, but a ReplicaSet scaled to zero that owns no
    // Pod, so a Deployment's old revisions do not crowd the map.
    let mut nodes: BTreeMap<String, GraphNode> = BTreeMap::new();
    let mut members: Vec<&Item> = Vec::new();
    for kind in Kind::ALL.into_iter().filter(|kind| !kind.is_leaf()) {
        for item in store.items(kind) {
            let id = item.id();
            if item.scaled_to_zero && !pod_owners.contains(&id) {
                continue;
            }
            nodes.insert(id, node_of(item));
            members.push(item);
        }
    }

    let pods_listable = store.listable(Kind::Pod);
    let mut edges = BTreeSet::new();
    // The ConfigMaps, Secrets, ServiceAccounts and claims shown because an edge points at them.
    let mut leaves: Vec<&Item> = Vec::new();
    for item in &members {
        let id = item.id();
        if let Some((kind, name)) = &item.owner {
            let owner = node_id(kind, &item.namespace, name);
            if nodes.contains_key(&owner) {
                edges.insert(edge(&owner, &id, GraphRel::Owns));
            }
        }
        if let Some(selector) = &item.selector {
            let mut any_ready = false;
            let pods = pods_by_namespace.get(item.namespace.as_str());
            for pod in pods.into_iter().flatten() {
                if selector.iter().all(|(k, v)| pod.labels.get(k) == Some(v)) {
                    edges.insert(edge(&id, &pod.id(), GraphRel::Selects));
                    any_ready |= pod.ready;
                }
            }
            if !any_ready && pods_listable {
                if let Some(node) = nodes.get_mut(&id) {
                    node.status = GraphStatus::Warning;
                    node.status_text = Some("No ready Pods".to_owned());
                }
            }
        }
        for reference in &item.refs {
            let target = reference.target.id();
            if !nodes.contains_key(&target) {
                let node = match store.get(&reference.target) {
                    Some(found) => {
                        leaves.push(found);
                        node_of(found)
                    }
                    None => absent(&reference.target, store.listable(reference.target.kind)),
                };
                nodes.insert(target.clone(), node);
            }
            let (from, to) = if reference.inbound {
                (&target, &id)
            } else {
                (&id, &target)
            };
            edges.insert(edge(from, to, reference.rel));
        }
        for address in &item.addresses {
            let balancer = node_id(LOAD_BALANCER, "", address);
            nodes
                .entry(balancer.clone())
                .or_insert_with(|| load_balancer(address));
            edges.insert(edge(&balancer, &id, GraphRel::Routes));
        }
    }

    // Spec E §4.5: any object's owner edge, so a claim a StatefulSet owns shows that too.
    for leaf in leaves {
        if let Some((kind, name)) = &leaf.owner {
            let owner = node_id(kind, &leaf.namespace, name);
            if nodes.contains_key(&owner) {
                edges.insert(edge(&owner, &leaf.id(), GraphRel::Owns));
            }
        }
    }

    // Cluster-scoped nodes have no namespace to count under.
    let mut counts: BTreeMap<String, u32> = BTreeMap::new();
    for node in nodes.values().filter(|node| !node.namespace.is_empty()) {
        *counts.entry(node.namespace.clone()).or_default() += 1;
    }
    Built {
        nodes: nodes.into_values().collect(),
        edges: edges.into_iter().collect(),
        counts: counts
            .into_iter()
            .map(|(namespace, nodes)| GraphNamespaceCount { namespace, nodes })
            .collect(),
        missing: store.missing(),
        gateway_api: store.gateway_api(),
    }
}

/// What one subscription sees (spec E §4.7). `None` is the whole graph. Otherwise: the nodes in
/// those namespaces, then every node joined to the view by a `routes` or `class` edge, until
/// nothing is added, and the edges between them. Counts, missing kinds and the Gateway API flag
/// always describe the whole graph.
pub(crate) fn view(built: &Built, namespaces: Option<&[String]>) -> GraphEvent {
    let (nodes, edges) = match namespaces {
        None => (built.nodes.clone(), built.edges.clone()),
        Some(namespaces) => {
            let mut members: HashSet<&str> = built
                .nodes
                .iter()
                .filter(|node| namespaces.contains(&node.namespace))
                .map(|node| node.id.as_str())
                .collect();
            let joins: Vec<&GraphEdge> = built
                .edges
                .iter()
                .filter(|edge| matches!(edge.rel, GraphRel::Routes | GraphRel::Class))
                .collect();
            loop {
                let before = members.len();
                for join in &joins {
                    if members.contains(join.from.as_str()) {
                        members.insert(join.to.as_str());
                    }
                    if members.contains(join.to.as_str()) {
                        members.insert(join.from.as_str());
                    }
                }
                if members.len() == before {
                    break;
                }
            }
            let nodes = built
                .nodes
                .iter()
                .filter(|node| members.contains(node.id.as_str()))
                .cloned()
                .collect();
            let edges = built
                .edges
                .iter()
                .filter(|e| members.contains(e.from.as_str()) && members.contains(e.to.as_str()))
                .cloned()
                .collect();
            (nodes, edges)
        }
    };
    GraphEvent::Snapshot {
        nodes,
        edges,
        counts: built.counts.clone(),
        missing: built.missing.clone(),
        gateway_api: built.gateway_api,
    }
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use serde_json::{json, Value};

    use super::*;
    use crate::resources::{ObjectKey, Row};

    fn row(object: &Value) -> Row {
        Row::new(object).unwrap()
    }

    /// A store of `kinds`, where each kind in `forbidden` failed and every other one listed
    /// what `objects` holds of it.
    fn store_of(kinds: &[Kind], forbidden: &[Kind], objects: &[(Kind, Value)]) -> Store {
        let mut store = Store::new(kinds);
        for kind in kinds {
            if forbidden.contains(kind) {
                let status = WatchEvent::Status {
                    status: WatchStatus::Forbidden,
                    message: None,
                };
                store.apply(*kind, status);
                continue;
            }
            let items = objects
                .iter()
                .filter(|(k, _)| k == kind)
                .map(|(_, o)| row(o))
                .collect();
            store.apply(*kind, WatchEvent::Snapshot { items });
        }
        store
    }

    fn built(objects: &[(Kind, Value)]) -> Built {
        build(&store_of(&Kind::ALL, &[], objects))
    }

    fn ids(built: &Built) -> Vec<&str> {
        built.nodes.iter().map(|n| n.id.as_str()).collect()
    }

    fn node<'a>(built: &'a Built, id: &str) -> &'a GraphNode {
        built
            .nodes
            .iter()
            .find(|n| n.id == id)
            .unwrap_or_else(|| panic!("no {id} in {:?}", ids(built)))
    }

    fn has_edge(built: &Built, from: &str, to: &str, rel: GraphRel) -> bool {
        built
            .edges
            .iter()
            .any(|e| e.from == from && e.to == to && e.rel == rel)
    }

    fn meta(namespace: &str, name: &str) -> Value {
        json!({ "name": name, "namespace": namespace })
    }

    fn owned(namespace: &str, name: &str, kind: &str, owner: &str) -> Value {
        json!({
            "name": name,
            "namespace": namespace,
            "ownerReferences": [{ "kind": kind, "name": owner, "controller": true }],
        })
    }

    fn pod(metadata: Value, labels: Value, ready: bool) -> Value {
        let mut metadata = metadata;
        metadata["labels"] = labels;
        json!({
            "metadata": metadata,
            "spec": { "serviceAccountName": "web", "containers": [{ "name": "app" }] },
            "status": {
                "phase": "Running",
                "conditions": [{ "type": "Ready", "status": if ready { "True" } else { "False" } }],
                "containerStatuses": [{ "name": "app", "ready": ready, "state": { "running": {} } }],
            },
        })
    }

    #[test]
    fn the_store_waits_for_every_kind_then_follows_changes() {
        let mut store = Store::new(&[Kind::Pod, Kind::Secret]);
        assert!(!store.ready());
        store.apply(
            Kind::Pod,
            WatchEvent::Status {
                status: WatchStatus::Syncing,
                message: None,
            },
        );
        store.apply(
            Kind::Pod,
            WatchEvent::Snapshot {
                items: vec![row(&pod(meta("a", "p1"), json!({}), true))],
            },
        );
        assert!(!store.ready(), "secrets have not listed yet");
        store.apply(
            Kind::Secret,
            WatchEvent::Status {
                status: WatchStatus::Forbidden,
                message: Some("no".into()),
            },
        );
        assert!(store.ready());

        store.apply(
            Kind::Pod,
            WatchEvent::Batch {
                upserts: vec![row(&pod(meta("a", "p2"), json!({}), true))],
                deletes: vec![ObjectKey {
                    namespace: Some("a".into()),
                    name: "p1".into(),
                }],
            },
        );
        let graph = build(&store);
        assert!(ids(&graph).contains(&"Pod/a/p2"));
        assert!(!ids(&graph).contains(&"Pod/a/p1"));
        assert_eq!(graph.missing, ["secrets"]);
        assert!(!graph.gateway_api);

        store.apply(
            Kind::Pod,
            WatchEvent::Status {
                status: WatchStatus::NotServed,
                message: None,
            },
        );
        let graph = build(&store);
        assert!(graph.nodes.is_empty());
        assert_eq!(graph.missing, ["pods", "secrets"]);
    }

    #[test]
    fn owners_need_a_controller_reference_and_a_node() {
        let graph = built(&[
            (
                Kind::Deployment,
                json!({ "metadata": meta("a", "web"), "spec": { "replicas": 1 } }),
            ),
            (
                Kind::ReplicaSet,
                json!({ "metadata": owned("a", "web-1", "Deployment", "web"), "spec": { "replicas": 1 } }),
            ),
            (
                Kind::Pod,
                pod(
                    owned("a", "web-1-x", "ReplicaSet", "web-1"),
                    json!({}),
                    true,
                ),
            ),
            (
                Kind::Pod,
                pod(owned("a", "static", "Node", "node-1"), json!({}), true),
            ),
            (
                Kind::Pod,
                pod(
                    json!({ "name": "loose", "namespace": "a", "ownerReferences": [{ "kind": "ReplicaSet", "name": "web-1" }] }),
                    json!({}),
                    true,
                ),
            ),
        ]);
        let owns: Vec<_> = graph
            .edges
            .iter()
            .filter(|e| e.rel == GraphRel::Owns)
            .map(|e| (e.from.as_str(), e.to.as_str()))
            .collect();
        assert_eq!(
            owns,
            [
                ("Deployment/a/web", "ReplicaSet/a/web-1"),
                ("ReplicaSet/a/web-1", "Pod/a/web-1-x"),
            ]
        );
    }

    #[test]
    fn a_shown_claim_keeps_its_owner_edge() {
        let claim = |name: &str| {
            (
                Kind::PersistentVolumeClaim,
                json!({ "metadata": owned("a", name, "StatefulSet", "db") }),
            )
        };
        let graph = built(&[
            (Kind::StatefulSet, json!({ "metadata": meta("a", "db") })),
            claim("data-db-0"),
            claim("data-db-1"),
            (
                Kind::Pod,
                json!({
                    "metadata": owned("a", "db-0", "StatefulSet", "db"),
                    "spec": { "volumes": [{ "persistentVolumeClaim": { "claimName": "data-db-0" } }] },
                }),
            ),
        ]);
        assert!(has_edge(
            &graph,
            "StatefulSet/a/db",
            "Pod/a/db-0",
            GraphRel::Owns
        ));
        assert!(has_edge(
            &graph,
            "Pod/a/db-0",
            "PersistentVolumeClaim/a/data-db-0",
            GraphRel::Claims
        ));
        assert!(has_edge(
            &graph,
            "StatefulSet/a/db",
            "PersistentVolumeClaim/a/data-db-0",
            GraphRel::Owns
        ));
        assert!(
            !ids(&graph).contains(&"PersistentVolumeClaim/a/data-db-1"),
            "no edge points at it"
        );
    }

    #[test]
    fn a_replica_set_scaled_to_zero_that_owns_no_pod_is_left_out() {
        let replica_set = |name: &str, replicas: i64| {
            (
                Kind::ReplicaSet,
                json!({ "metadata": owned("a", name, "Deployment", "web"), "spec": { "replicas": replicas } }),
            )
        };
        let graph = built(&[
            (Kind::Deployment, json!({ "metadata": meta("a", "web") })),
            replica_set("old", 0),
            replica_set("draining", 0),
            replica_set("current", 1),
            (
                Kind::Pod,
                pod(
                    owned("a", "draining-x", "ReplicaSet", "draining"),
                    json!({}),
                    false,
                ),
            ),
        ]);
        let ids = ids(&graph);
        assert!(!ids.contains(&"ReplicaSet/a/old"));
        assert!(ids.contains(&"ReplicaSet/a/draining"));
        assert!(ids.contains(&"ReplicaSet/a/current"));
        assert!(has_edge(
            &graph,
            "Deployment/a/web",
            "ReplicaSet/a/draining",
            GraphRel::Owns
        ));
    }

    #[test]
    fn a_service_selects_pods_of_its_namespace_and_says_when_none_is_ready() {
        let service = |name: &str, selector: Value| {
            (
                Kind::Service,
                json!({ "metadata": meta("a", name), "spec": { "selector": selector } }),
            )
        };
        let graph = built(&[
            service("web", json!({ "app": "web" })),
            service("up", json!({ "app": "up" })),
            service("bare", json!({})),
            (
                Kind::Pod,
                pod(meta("a", "p1"), json!({ "app": "web" }), false),
            ),
            (
                Kind::Pod,
                pod(meta("a", "p2"), json!({ "app": "web", "tier": "x" }), false),
            ),
            (
                Kind::Pod,
                pod(meta("a", "p3"), json!({ "app": "other" }), true),
            ),
            (
                Kind::Pod,
                pod(meta("b", "p4"), json!({ "app": "web" }), true),
            ),
            (
                Kind::Pod,
                pod(meta("a", "u1"), json!({ "app": "up" }), true),
            ),
        ]);
        let selects: Vec<_> = graph
            .edges
            .iter()
            .filter(|e| e.rel == GraphRel::Selects)
            .map(|e| (e.from.as_str(), e.to.as_str()))
            .collect();
        assert_eq!(
            selects,
            [
                ("Service/a/up", "Pod/a/u1"),
                ("Service/a/web", "Pod/a/p1"),
                ("Service/a/web", "Pod/a/p2"),
            ]
        );
        let web = node(&graph, "Service/a/web");
        assert_eq!(
            (web.status, web.status_text.as_deref()),
            (GraphStatus::Warning, Some("No ready Pods"))
        );
        assert_eq!(node(&graph, "Service/a/up").status, GraphStatus::Nominal);
        assert_eq!(node(&graph, "Service/a/bare").status, GraphStatus::Nominal);
    }

    #[test]
    fn a_service_is_not_blamed_when_pods_cannot_be_listed() {
        let graph = build(&store_of(
            &Kind::ALL,
            &[Kind::Pod],
            &[(
                Kind::Service,
                json!({ "metadata": meta("a", "web"), "spec": { "selector": { "app": "web" } } }),
            )],
        ));
        assert_eq!(node(&graph, "Service/a/web").status, GraphStatus::Nominal);
    }

    #[test]
    fn references_become_nodes_and_absent_objects_are_marked() {
        let kinds: Vec<Kind> = Kind::ALL
            .into_iter()
            .filter(|k| *k != Kind::PersistentVolumeClaim)
            .collect();
        let graph = build(&store_of(
            &kinds,
            &[Kind::Secret],
            &[
                (
                    Kind::ConfigMap,
                    json!({ "metadata": meta("a", "present"), "data": { "k": "v" } }),
                ),
                (Kind::ConfigMap, json!({ "metadata": meta("a", "lonely") })),
                (
                    Kind::Pod,
                    json!({
                        "metadata": meta("a", "p"),
                        "spec": {
                            "serviceAccountName": "web",
                            "volumes": [
                                { "configMap": { "name": "present" } },
                                { "configMap": { "name": "absent" } },
                                { "secret": { "secretName": "s" } },
                                { "persistentVolumeClaim": { "claimName": "data" } },
                            ],
                            "containers": [{ "name": "app" }],
                        },
                    }),
                ),
            ],
        ));

        let present = node(&graph, "ConfigMap/a/present");
        assert_eq!(
            (present.status, present.status_text.as_deref()),
            (GraphStatus::Neutral, None)
        );
        assert_eq!(present.facts, [("Keys".to_owned(), "1".to_owned())]);
        let absent = node(&graph, "ConfigMap/a/absent");
        assert_eq!(
            (absent.status, absent.status_text.as_deref()),
            (GraphStatus::Critical, Some("Not found"))
        );
        assert!(absent.facts.is_empty());
        let account = node(&graph, "ServiceAccount/a/web");
        assert_eq!(account.status_text.as_deref(), Some("Not found"));
        for hidden in ["Secret/a/s", "PersistentVolumeClaim/a/data"] {
            let node = node(&graph, hidden);
            assert_eq!(
                (node.status, node.status_text.as_deref()),
                (GraphStatus::Neutral, None),
                "{hidden}"
            );
            assert!(node.facts.is_empty(), "{hidden}");
            assert!(node.created.is_none(), "{hidden}");
        }
        assert_eq!(
            (
                node(&graph, "Secret/a/s").group.as_str(),
                node(&graph, "Secret/a/s").plural.as_str()
            ),
            ("", "secrets")
        );
        assert!(
            !ids(&graph).contains(&"ConfigMap/a/lonely"),
            "a ConfigMap no edge points at is not shown"
        );
        assert_eq!(
            graph.missing,
            ["secrets"],
            "a kind that is not served is not missing"
        );
        for (to, rel) in [
            ("ConfigMap/a/present", GraphRel::Mounts),
            ("ConfigMap/a/absent", GraphRel::Mounts),
            ("Secret/a/s", GraphRel::Mounts),
            ("PersistentVolumeClaim/a/data", GraphRel::Claims),
            ("ServiceAccount/a/web", GraphRel::RunsAs),
        ] {
            assert!(has_edge(&graph, "Pod/a/p", to, rel), "{to}");
        }
    }

    #[test]
    fn routes_and_load_balancers() {
        let graph = built(&[
            (
                Kind::Ingress,
                json!({
                    "metadata": meta("a", "web"),
                    "spec": { "defaultBackend": { "service": { "name": "web" } } },
                    "status": { "loadBalancer": { "ingress": [{ "ip": "10.0.0.9" }] } },
                }),
            ),
            (
                Kind::Service,
                json!({
                    "metadata": meta("a", "web"),
                    "spec": { "type": "LoadBalancer" },
                    "status": { "loadBalancer": { "ingress": [{ "ip": "10.0.0.9" }] } },
                }),
            ),
            (Kind::GatewayClass, json!({ "metadata": { "name": "cls" } })),
            (
                Kind::Gateway,
                json!({
                    "metadata": meta("a", "edge"),
                    "spec": { "gatewayClassName": "cls" },
                    "status": { "addresses": [{ "value": "10.0.0.10" }] },
                }),
            ),
            (
                Kind::HttpRoute,
                json!({
                    "metadata": meta("a", "r"),
                    "spec": { "parentRefs": [{ "name": "edge" }], "rules": [{ "backendRefs": [{ "name": "web", "port": 80 }] }] },
                }),
            ),
            (
                Kind::HttpRoute,
                json!({ "metadata": meta("a", "orphan"), "spec": { "parentRefs": [{ "name": "gone" }] } }),
            ),
        ]);
        let balancer = node(&graph, "LoadBalancer//10.0.0.9");
        assert_eq!(
            (
                balancer.kind.as_str(),
                balancer.group.as_str(),
                balancer.plural.as_str(),
                balancer.namespace.as_str(),
                balancer.name.as_str()
            ),
            ("LoadBalancer", "", "", "", "10.0.0.9")
        );
        assert_eq!(
            (balancer.status, balancer.created.as_deref()),
            (GraphStatus::Neutral, None)
        );
        assert_eq!(
            balancer.facts,
            [("Address".to_owned(), "10.0.0.9".to_owned())]
        );
        for (from, to, rel) in [
            ("LoadBalancer//10.0.0.9", "Ingress/a/web", GraphRel::Routes),
            ("LoadBalancer//10.0.0.9", "Service/a/web", GraphRel::Routes),
            (
                "LoadBalancer//10.0.0.10",
                "Gateway/a/edge",
                GraphRel::Routes,
            ),
            ("Ingress/a/web", "Service/a/web", GraphRel::Routes),
            ("Gateway/a/edge", "GatewayClass//cls", GraphRel::Class),
            ("Gateway/a/edge", "HTTPRoute/a/r", GraphRel::Routes),
            ("HTTPRoute/a/r", "Service/a/web", GraphRel::Routes),
            ("Gateway/a/gone", "HTTPRoute/a/orphan", GraphRel::Routes),
        ] {
            assert!(has_edge(&graph, from, to, rel), "{from} {rel:?} {to}");
        }
        let gone = node(&graph, "Gateway/a/gone");
        assert_eq!(
            (gone.status, gone.status_text.as_deref()),
            (GraphStatus::Critical, Some("Not found"))
        );
        assert!(graph.gateway_api);
        let in_a =
            u32::try_from(graph.nodes.iter().filter(|n| n.namespace == "a").count()).unwrap();
        assert_eq!(
            graph.counts,
            [GraphNamespaceCount {
                namespace: "a".into(),
                nodes: in_a
            }]
        );
    }

    #[test]
    fn edges_appear_once_and_in_order() {
        let graph = built(&[
            (
                Kind::Ingress,
                json!({
                    "metadata": meta("a", "web"),
                    "spec": {
                        "defaultBackend": { "service": { "name": "web" } },
                        "rules": [{ "http": { "paths": [{ "backend": { "service": { "name": "web" } } }] } }],
                    },
                }),
            ),
            (
                Kind::Pod,
                json!({
                    "metadata": meta("a", "p"),
                    "spec": {
                        "volumes": [{ "secret": { "secretName": "s" } }],
                        "containers": [{ "name": "app", "envFrom": [{ "secretRef": { "name": "s" } }] }],
                    },
                }),
            ),
        ]);
        let mut sorted = graph.edges.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(graph.edges, sorted);
        let to_secret = graph.edges.iter().filter(|e| e.to == "Secret/a/s").count();
        assert_eq!(to_secret, 2, "one mounts edge and one env edge");
        let mut node_ids = ids(&graph);
        node_ids.sort_unstable();
        assert_eq!(ids(&graph), node_ids);
    }

    #[test]
    fn counts_cover_every_namespace_by_name() {
        let graph = built(&[
            (Kind::Deployment, json!({ "metadata": meta("b", "x") })),
            (Kind::Deployment, json!({ "metadata": meta("a", "y") })),
            (Kind::Deployment, json!({ "metadata": meta("a", "z") })),
            (Kind::GatewayClass, json!({ "metadata": { "name": "cls" } })),
        ]);
        assert_eq!(
            graph.counts,
            [
                GraphNamespaceCount {
                    namespace: "a".into(),
                    nodes: 2
                },
                GraphNamespaceCount {
                    namespace: "b".into(),
                    nodes: 1
                },
            ]
        );
    }

    fn shared_gateway() -> Built {
        let route = |namespace: &str, name: &str, backend: &str| {
            (
                Kind::HttpRoute,
                json!({
                    "metadata": meta(namespace, name),
                    "spec": {
                        "parentRefs": [{ "name": "shared", "namespace": "infra" }],
                        "rules": [{ "backendRefs": [{ "name": backend, "port": 80 }] }],
                    },
                }),
            )
        };
        let service = |namespace: &str, name: &str, app: &str| {
            (
                Kind::Service,
                json!({ "metadata": meta(namespace, name), "spec": { "selector": { "app": app } } }),
            )
        };
        built(&[
            (Kind::GatewayClass, json!({ "metadata": { "name": "cls" } })),
            (
                Kind::Gateway,
                json!({
                    "metadata": meta("infra", "shared"),
                    "spec": { "gatewayClassName": "cls" },
                    "status": { "addresses": [{ "value": "10.0.0.9" }] },
                }),
            ),
            route("a", "ra", "svc-a"),
            route("b", "rb", "svc-b"),
            service("a", "svc-a", "a"),
            service("b", "svc-b", "b"),
            (Kind::Pod, pod(meta("a", "pa"), json!({ "app": "a" }), true)),
            (Kind::Pod, pod(meta("b", "pb"), json!({ "app": "b" }), true)),
        ])
    }

    fn snapshot_ids(event: &GraphEvent) -> (Vec<&str>, Vec<(&str, &str)>) {
        let GraphEvent::Snapshot { nodes, edges, .. } = event else {
            panic!("a snapshot");
        };
        (
            nodes.iter().map(|n| n.id.as_str()).collect(),
            edges
                .iter()
                .map(|e| (e.from.as_str(), e.to.as_str()))
                .collect(),
        )
    }

    #[test]
    fn a_namespace_view_follows_routes_and_classes_but_never_reaches_other_pods() {
        let graph = shared_gateway();
        let event = view(&graph, Some(&["a".to_owned()][..]));
        let (nodes, edges) = snapshot_ids(&event);
        assert_eq!(
            nodes,
            [
                "Gateway/infra/shared",
                "GatewayClass//cls",
                "HTTPRoute/a/ra",
                "HTTPRoute/b/rb",
                "LoadBalancer//10.0.0.9",
                "Pod/a/pa",
                "Service/a/svc-a",
                "Service/b/svc-b",
                "ServiceAccount/a/web",
            ]
        );
        assert!(edges.contains(&("HTTPRoute/b/rb", "Service/b/svc-b")));
        assert!(!edges.contains(&("Service/b/svc-b", "Pod/b/pb")));
        let GraphEvent::Snapshot {
            counts,
            missing,
            gateway_api,
            ..
        } = &event
        else {
            unreachable!()
        };
        assert_eq!(counts, &graph.counts, "counts describe the whole graph");
        assert_eq!((missing.len(), *gateway_api), (0, true));

        let GraphEvent::Snapshot { nodes, edges, .. } = view(&graph, None) else {
            unreachable!()
        };
        assert_eq!((nodes, edges), (graph.nodes.clone(), graph.edges.clone()));

        for filter in [vec![], vec!["nowhere".to_owned()]] {
            let event = view(&graph, Some(filter.as_slice()));
            let (nodes, edges) = snapshot_ids(&event);
            assert!(nodes.is_empty() && edges.is_empty(), "{filter:?}");
            let GraphEvent::Snapshot { counts, .. } = &event else {
                unreachable!()
            };
            assert_eq!(counts, &graph.counts);
        }
    }

    /// Review Focus 2: even from objects that still hold them, no value reaches a snapshot.
    #[test]
    fn no_secret_or_env_value_reaches_a_snapshot() {
        let graph = built(&[
            (
                Kind::Secret,
                json!({ "metadata": meta("a", "s"), "type": "Opaque", "data": { "token": "c2VjcmV0LXZhbHVl" }, "stringData": { "raw": "raw-secret-value" } }),
            ),
            (
                Kind::Pod,
                json!({
                    "metadata": meta("a", "p"),
                    "spec": { "containers": [{
                        "name": "app",
                        "env": [{ "name": "PLAIN", "value": "plain-env-value" }],
                        "envFrom": [{ "secretRef": { "name": "s" } }],
                    }] },
                }),
            ),
        ]);
        let text = serde_json::to_string(&view(&graph, None)).unwrap();
        for value in ["c2VjcmV0LXZhbHVl", "raw-secret-value", "plain-env-value"] {
            assert!(!text.contains(value), "{value} in {text}");
        }
        assert_eq!(
            node(&graph, "Secret/a/s").facts,
            [
                ("Type".to_owned(), "Opaque".to_owned()),
                ("Keys".to_owned(), "1".to_owned()),
            ]
        );
    }

    /// Review Focus 5: one build of a large cluster stays well inside the 2 s interval.
    #[test]
    fn a_large_cluster_builds_quickly() {
        let mut objects = Vec::new();
        for n in 0..20 {
            let namespace = format!("ns-{n}");
            objects.push((
                Kind::Deployment,
                json!({ "metadata": meta(&namespace, "web") }),
            ));
            objects.push((
                Kind::ReplicaSet,
                json!({ "metadata": owned(&namespace, "web-1", "Deployment", "web") }),
            ));
            for s in 0..10 {
                let app = format!("app-{s}");
                objects.push((Kind::Service, json!({ "metadata": meta(&namespace, &app), "spec": { "selector": { "app": app } } })));
            }
            for p in 0..100 {
                let labels = json!({ "app": format!("app-{}", p % 10) });
                objects.push((
                    Kind::Pod,
                    pod(
                        owned(&namespace, &format!("web-1-{p}"), "ReplicaSet", "web-1"),
                        labels,
                        true,
                    ),
                ));
            }
        }
        let store = store_of(&Kind::ALL, &[], &objects);
        let started = Instant::now();
        let graph = build(&store);
        let took = started.elapsed();
        assert_eq!(
            graph
                .edges
                .iter()
                .filter(|e| e.rel == GraphRel::Selects)
                .count(),
            2_000
        );
        assert!(took.as_millis() < 2_000, "{took:?}");
    }
}
