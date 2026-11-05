//! Discovery documents served by the fake API server.

use serde_json::{json, Value};

pub const AGGREGATED_CONTENT_TYPE: &str =
    "application/json;g=apidiscovery.k8s.io;v=v2;as=APIGroupDiscoveryList";

const VERBS: [&str; 7] = [
    "create", "delete", "get", "list", "patch", "update", "watch",
];

struct Res {
    plural: &'static str,
    singular: &'static str,
    kind: &'static str,
    namespaced: bool,
    verbs: &'static [&'static str],
    short: &'static [&'static str],
}

const CORE: &[Res] = &[
    Res {
        plural: "namespaces",
        singular: "namespace",
        kind: "Namespace",
        namespaced: false,
        verbs: &["get", "list", "watch"],
        short: &["ns"],
    },
    Res {
        plural: "pods",
        singular: "pod",
        kind: "Pod",
        namespaced: true,
        verbs: &VERBS,
        short: &["po"],
    },
    Res {
        plural: "nodes",
        singular: "node",
        kind: "Node",
        namespaced: false,
        verbs: &["get", "list", "watch"],
        short: &["no"],
    },
    Res {
        plural: "events",
        singular: "event",
        kind: "Event",
        namespaced: true,
        verbs: &["get", "list", "watch"],
        short: &["ev"],
    },
];

const APPS: &[Res] = &[Res {
    plural: "deployments",
    singular: "deployment",
    kind: "Deployment",
    namespaced: true,
    verbs: &VERBS,
    short: &["deploy"],
}];

const AUTHZ: &[Res] = &[Res {
    plural: "selfsubjectaccessreviews",
    singular: "selfsubjectaccessreview",
    kind: "SelfSubjectAccessReview",
    namespaced: false,
    verbs: &["create"],
    short: &[],
}];

fn v2_resource(group: &str, version: &str, r: &Res) -> Value {
    json!({
        "resource": r.plural,
        "responseKind": { "group": group, "version": version, "kind": r.kind },
        "scope": if r.namespaced { "Namespaced" } else { "Cluster" },
        "singularResource": r.singular,
        "verbs": r.verbs,
        "shortNames": r.short,
    })
}

fn v2_group(name: Option<&str>, version: &str, rs: &[Res]) -> Value {
    let group = name.unwrap_or("");
    let resources: Vec<Value> = rs.iter().map(|r| v2_resource(group, version, r)).collect();
    let versions = json!([{ "version": version, "resources": resources, "freshness": "Current" }]);
    match name {
        Some(n) => json!({ "metadata": { "name": n }, "versions": versions }),
        None => json!({ "metadata": {}, "versions": versions }),
    }
}

fn v2_list(items: Vec<Value>) -> Value {
    json!({
        "kind": "APIGroupDiscoveryList",
        "apiVersion": "apidiscovery.k8s.io/v2",
        "metadata": {},
        "items": items,
    })
}

pub fn aggregated_core() -> Value {
    v2_list(vec![v2_group(None, "v1", CORE)])
}

pub fn aggregated_apis() -> Value {
    v2_list(vec![
        v2_group(Some("apps"), "v1", APPS),
        v2_group(Some("authorization.k8s.io"), "v1", AUTHZ),
    ])
}

pub fn legacy_api_versions() -> Value {
    json!({
        "kind": "APIVersions",
        "versions": ["v1"],
        "serverAddressByClientCIDRs": [{ "clientCIDR": "0.0.0.0/0", "serverAddress": "127.0.0.1:6443" }],
    })
}

pub fn legacy_api_group_list() -> Value {
    let group = |name: &str| {
        let gv = json!({ "groupVersion": format!("{name}/v1"), "version": "v1" });
        json!({ "name": name, "versions": [gv.clone()], "preferredVersion": gv })
    };
    json!({
        "kind": "APIGroupList",
        "apiVersion": "v1",
        "groups": [group("apps"), group("authorization.k8s.io")],
    })
}

fn resource_list(group_version: &str, rs: &[Res]) -> Value {
    let resources: Vec<Value> = rs
        .iter()
        .map(|r| {
            json!({
                "name": r.plural,
                "singularName": r.singular,
                "namespaced": r.namespaced,
                "kind": r.kind,
                "verbs": r.verbs,
                "shortNames": r.short,
            })
        })
        .collect();
    json!({
        "kind": "APIResourceList",
        "apiVersion": "v1",
        "groupVersion": group_version,
        "resources": resources,
    })
}

pub fn core_v1_resources() -> Value {
    resource_list("v1", CORE)
}

pub fn apps_v1_resources() -> Value {
    resource_list("apps/v1", APPS)
}

pub fn authz_v1_resources() -> Value {
    resource_list("authorization.k8s.io/v1", AUTHZ)
}
