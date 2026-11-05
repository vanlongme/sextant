//! Discovery documents served by the fake API server, built from the
//! resources currently served.

use std::collections::BTreeMap;

use serde_json::{json, Value};

use crate::objects::FakeResource;

pub const AGGREGATED_CONTENT_TYPE: &str =
    "application/json;g=apidiscovery.k8s.io;v=v2;as=APIGroupDiscoveryList";

/// group -> versions (in first-seen order) -> resources.
type Grouped<'a> = BTreeMap<&'a str, Vec<(&'a str, Vec<&'a FakeResource>)>>;

fn grouped(rs: &[FakeResource]) -> Grouped<'_> {
    let mut out: Grouped = BTreeMap::new();
    for r in rs {
        let versions = out.entry(r.group.as_str()).or_default();
        match versions.iter_mut().find(|(v, _)| *v == r.version) {
            Some((_, list)) => list.push(r),
            None => versions.push((r.version.as_str(), vec![r])),
        }
    }
    out
}

fn v2_resource(r: &FakeResource) -> Value {
    json!({
        "resource": r.plural,
        "responseKind": { "group": r.group, "version": r.version, "kind": r.kind },
        "scope": if r.namespaced { "Namespaced" } else { "Cluster" },
        "singularResource": r.singular(),
        "verbs": r.verbs(),
        "shortNames": r.short_names(),
    })
}

fn v2_group(name: &str, versions: &[(&str, Vec<&FakeResource>)]) -> Value {
    let versions: Vec<Value> = versions
        .iter()
        .map(|(v, rs)| {
            let resources: Vec<Value> = rs.iter().map(|r| v2_resource(r)).collect();
            json!({ "version": v, "resources": resources, "freshness": "Current" })
        })
        .collect();
    if name.is_empty() {
        json!({ "metadata": {}, "versions": versions })
    } else {
        json!({ "metadata": { "name": name }, "versions": versions })
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

pub fn aggregated_core(rs: &[FakeResource]) -> Value {
    let g = grouped(rs);
    v2_list(g.get("").map(|v| vec![v2_group("", v)]).unwrap_or_default())
}

pub fn aggregated_apis(rs: &[FakeResource]) -> Value {
    let g = grouped(rs);
    v2_list(
        g.iter()
            .filter(|(name, _)| !name.is_empty())
            .map(|(name, v)| v2_group(name, v))
            .collect(),
    )
}

pub fn legacy_api_versions() -> Value {
    json!({
        "kind": "APIVersions",
        "versions": ["v1"],
        "serverAddressByClientCIDRs": [{ "clientCIDR": "0.0.0.0/0", "serverAddress": "127.0.0.1:6443" }],
    })
}

pub fn legacy_api_group_list(rs: &[FakeResource]) -> Value {
    let groups: Vec<Value> = grouped(rs)
        .iter()
        .filter(|(name, _)| !name.is_empty())
        .map(|(name, versions)| {
            let vs: Vec<Value> = versions
                .iter()
                .map(|(v, _)| json!({ "groupVersion": format!("{name}/{v}"), "version": v }))
                .collect();
            json!({ "name": name, "versions": vs, "preferredVersion": vs[0] })
        })
        .collect();
    json!({ "kind": "APIGroupList", "apiVersion": "v1", "groups": groups })
}

/// The `APIResourceList` for one group version, or `None` when nothing is served there.
pub fn resource_list(rs: &[FakeResource], group: &str, version: &str) -> Option<Value> {
    let matching: Vec<&FakeResource> = rs
        .iter()
        .filter(|r| r.group == group && r.version == version)
        .collect();
    if matching.is_empty() {
        return None;
    }
    let resources: Vec<Value> = matching
        .iter()
        .map(|r| {
            json!({
                "name": r.plural,
                "singularName": r.singular(),
                "namespaced": r.namespaced,
                "kind": r.kind,
                "verbs": r.verbs(),
                "shortNames": r.short_names(),
            })
        })
        .collect();
    Some(json!({
        "kind": "APIResourceList",
        "apiVersion": "v1",
        "groupVersion": r_gv(group, version),
        "resources": resources,
    }))
}

fn r_gv(group: &str, version: &str) -> String {
    if group.is_empty() {
        version.to_string()
    } else {
        format!("{group}/{version}")
    }
}
