//! Types and pure helpers for the generic object store of the fake API server:
//! resource descriptions, deny rules, request path parsing, selectors and patches.

use serde_json::Value;

/// A resource type the fake serves and advertises in discovery.
#[derive(Clone, Debug)]
pub struct FakeResource {
    pub group: String,
    pub version: String,
    pub kind: String,
    pub plural: String,
    pub namespaced: bool,
}

impl FakeResource {
    pub fn new(group: &str, version: &str, kind: &str, plural: &str, namespaced: bool) -> Self {
        FakeResource {
            group: group.into(),
            version: version.into(),
            kind: kind.into(),
            plural: plural.into(),
            namespaced,
        }
    }

    pub fn api_version(&self) -> String {
        if self.group.is_empty() {
            self.version.clone()
        } else {
            format!("{}/{}", self.group, self.version)
        }
    }

    pub fn singular(&self) -> String {
        self.kind.to_lowercase()
    }

    pub fn short_names(&self) -> &'static [&'static str] {
        match self.plural.as_str() {
            "pods" => &["po"],
            "namespaces" => &["ns"],
            "nodes" => &["no"],
            "events" => &["ev"],
            "configmaps" => &["cm"],
            "services" => &["svc"],
            "deployments" => &["deploy"],
            "customresourcedefinitions" => &["crd", "crds"],
            _ => &[],
        }
    }

    pub fn verbs(&self) -> &'static [&'static str] {
        if self.plural == "selfsubjectaccessreviews" {
            &["create"]
        } else {
            &[
                "create", "delete", "get", "list", "patch", "update", "watch",
            ]
        }
    }
}

/// The resources served by default.
pub fn default_resources() -> Vec<FakeResource> {
    vec![
        FakeResource::new("", "v1", "Namespace", "namespaces", false),
        FakeResource::new("", "v1", "Pod", "pods", true),
        FakeResource::new("", "v1", "Node", "nodes", false),
        FakeResource::new("", "v1", "Event", "events", true),
        FakeResource::new("", "v1", "ConfigMap", "configmaps", true),
        FakeResource::new("", "v1", "Secret", "secrets", true),
        FakeResource::new("", "v1", "Service", "services", true),
        FakeResource::new("apps", "v1", "Deployment", "deployments", true),
        FakeResource::new(
            "apiextensions.k8s.io",
            "v1",
            "CustomResourceDefinition",
            "customresourcedefinitions",
            false,
        ),
        FakeResource::new(
            "authorization.k8s.io",
            "v1",
            "SelfSubjectAccessReview",
            "selfsubjectaccessreviews",
            false,
        ),
    ]
}

/// A request the fake refuses with 403 and reports as not allowed in access reviews.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DenyRule {
    pub verb: String,
    pub plural: String,
    /// `None` matches any request for that plural.
    pub namespace: Option<String>,
}

impl DenyRule {
    pub fn matches(&self, verb: &str, plural: &str, namespace: Option<&str>) -> bool {
        self.verb == verb
            && self.plural == plural
            && self
                .namespace
                .as_deref()
                .is_none_or(|n| Some(n) == namespace)
    }
}

/// What a request path addresses.
#[derive(Debug, PartialEq, Eq)]
pub struct Target {
    pub group: String,
    pub version: String,
    pub namespace: Option<String>,
    pub plural: String,
    pub name: Option<String>,
    pub subresource: Option<String>,
}

/// Parses `/api/v1/...` and `/apis/{group}/{version}/...` resource paths, with an
/// optional subresource after the object name. Anything longer gives `None`.
pub fn parse_path(path: &str) -> Option<Target> {
    let segs: Vec<&str> = path.trim_matches('/').split('/').collect();
    let (group, version, rest): (String, String, &[&str]) = match segs.as_slice() {
        ["api", v, rest @ ..] => (String::new(), (*v).to_string(), rest),
        ["apis", g, v, rest @ ..] => ((*g).to_string(), (*v).to_string(), rest),
        _ => return None,
    };
    let (namespace, plural, name, subresource) = match rest {
        ["namespaces", ns, plural] => (Some(*ns), *plural, None, None),
        ["namespaces", ns, plural, name] => (Some(*ns), *plural, Some(*name), None),
        [plural] => (None, *plural, None, None),
        [plural, name] => (None, *plural, Some(*name), None),
        ["namespaces", ns, plural, name, sub] => (Some(*ns), *plural, Some(*name), Some(*sub)),
        [plural, name, sub] => (None, *plural, Some(*name), Some(*sub)),
        _ => return None,
    };
    if plural.is_empty() {
        return None;
    }
    Some(Target {
        group,
        version,
        namespace: namespace.map(str::to_string),
        plural: plural.to_string(),
        name: name.map(str::to_string),
        subresource: subresource.map(str::to_string),
    })
}

fn split_top_level(s: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut depth = 0usize;
    let mut start = 0;
    for (i, c) in s.char_indices() {
        match c {
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            ',' if depth == 0 => {
                parts.push(&s[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    parts.push(&s[start..]);
    parts
        .into_iter()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .collect()
}

fn set_members(s: &str) -> Vec<&str> {
    s.trim()
        .trim_start_matches('(')
        .trim_end_matches(')')
        .split(',')
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .collect()
}

/// Kubernetes label selector syntax: `a=b`, `a==b`, `a!=b`, `a`, `!a`,
/// `a in (x,y)`, `a notin (x,y)`, comma separated.
pub fn label_selector_matches(selector: &str, obj: &Value) -> bool {
    let labels = obj.pointer("/metadata/labels");
    let get = |k: &str| labels.and_then(|l| l.get(k)).and_then(Value::as_str);
    split_top_level(selector).into_iter().all(|term| {
        if let Some((k, set)) = term.split_once(" notin ") {
            return !get(k.trim()).is_some_and(|v| set_members(set).contains(&v));
        }
        if let Some((k, set)) = term.split_once(" in ") {
            return get(k.trim()).is_some_and(|v| set_members(set).contains(&v));
        }
        if let Some((k, v)) = term.split_once("!=") {
            return get(k.trim()) != Some(v.trim());
        }
        if let Some((k, v)) = term.split_once("==").or_else(|| term.split_once('=')) {
            return get(k.trim()) == Some(v.trim());
        }
        if let Some(k) = term.strip_prefix('!') {
            return get(k.trim()).is_none();
        }
        get(term).is_some()
    })
}

fn field_value(obj: &Value, path: &str) -> String {
    let mut cur = obj;
    for part in path.split('.') {
        match cur.get(part) {
            Some(v) => cur = v,
            None => return String::new(),
        }
    }
    match cur {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// Field selectors on any dotted path, such as `metadata.name` or
/// `involvedObject.name`. A missing field compares as the empty string.
pub fn field_selector_matches(selector: &str, obj: &Value) -> bool {
    split_top_level(selector).into_iter().all(|term| {
        if let Some((k, v)) = term.split_once("!=") {
            return field_value(obj, k.trim()) != v.trim();
        }
        if let Some((k, v)) = term.split_once("==").or_else(|| term.split_once('=')) {
            return field_value(obj, k.trim()) == v.trim();
        }
        false
    })
}

/// RFC 7386 JSON merge patch.
pub fn merge_patch(target: &mut Value, patch: &Value) {
    let Value::Object(p) = patch else {
        *target = patch.clone();
        return;
    };
    if !target.is_object() {
        *target = Value::Object(Default::default());
    }
    if let Value::Object(t) = target {
        for (k, v) in p {
            if v.is_null() {
                t.remove(k);
            } else {
                merge_patch(t.entry(k.clone()).or_insert(Value::Null), v);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn paths() {
        let t = parse_path("/api/v1/namespaces/a/pods/p").unwrap();
        assert_eq!(
            (t.namespace.as_deref(), t.plural.as_str()),
            (Some("a"), "pods")
        );
        assert_eq!(t.name.as_deref(), Some("p"));
        let t = parse_path("/api/v1/namespaces/a").unwrap();
        assert_eq!(
            (t.plural.as_str(), t.name.as_deref()),
            ("namespaces", Some("a"))
        );
        let t = parse_path("/apis/example.com/v1/widgets").unwrap();
        assert_eq!(
            (t.group.as_str(), t.plural.as_str()),
            ("example.com", "widgets")
        );
        let t = parse_path("/api/v1/namespaces/a/pods/p/log").unwrap();
        assert_eq!(t.subresource.as_deref(), Some("log"));
        assert!(t.name.as_deref() == Some("p") && t.plural == "pods");
        assert!(parse_path("/api/v1/namespaces/a/pods/p/log/x").is_none());
    }

    #[test]
    fn selectors() {
        let o = json!({"metadata": {"name": "n", "labels": {"app": "x", "tier": "web"}},
            "involvedObject": {"name": "pod-1"}});
        assert!(label_selector_matches("app=x,tier in (web,db)", &o));
        assert!(label_selector_matches("app!=y,!zzz,tier", &o));
        assert!(!label_selector_matches("app notin (x)", &o));
        assert!(field_selector_matches(
            "metadata.name=n,involvedObject.name==pod-1",
            &o
        ));
        assert!(!field_selector_matches("metadata.name!=n", &o));
    }

    #[test]
    fn merge() {
        let mut t = json!({"a": {"b": 1, "c": 2}, "d": 1});
        merge_patch(&mut t, &json!({"a": {"b": null, "e": 3}}));
        assert_eq!(t, json!({"a": {"c": 2, "e": 3}, "d": 1}));
    }
}
