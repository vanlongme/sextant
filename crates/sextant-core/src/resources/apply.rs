//! Applies a stream of YAML documents with server-side apply, each on its own.

use std::sync::Arc;
use std::time::Duration;

use kube::api::{DynamicObject, Patch, PatchParams};
use kube::core::discovery::{ApiCapabilities, Scope};
use kube::core::{ApiResource, GroupVersionKind, Request, Resource};
use kube::{Client, Discovery};
use serde::de::{self, IntoDeserializer, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};
use tokio::time::Instant;
use ts_rs::TS;

use super::ops::{invalid, is_path_segment, send};
use crate::app_core::AppCore;
use crate::cluster::ConnectionState;
use crate::error::{sanitize_text, CoreResult};
use crate::kubeconfig::{with_location, ClusterId};

const FIELD_MANAGER: &str = "sextant";
const CRD_GROUP: &str = "apiextensions.k8s.io";
const CRD_KIND: &str = "CustomResourceDefinition";
const MERGE_KEY: &str = "<<";
/// How long a kind may stay unknown after a CRD in the same request was applied.
const ESTABLISH_LIMIT: Duration = Duration::from_secs(10);
const ESTABLISH_POLL: Duration = Duration::from_millis(500);
/// The fields that say what a document is and where it goes.
const IDENTITY_FIELDS: [(&str, &str); 4] = [
    ("/apiVersion", "apiVersion"),
    ("/kind", "kind"),
    ("/metadata/namespace", "metadata.namespace"),
    ("/metadata/name", "metadata.name"),
];

/// The outcome of one document. `index` counts the documents that are not empty.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub index: u32,
    pub kind: Option<String>,
    pub namespace: Option<String>,
    pub name: Option<String>,
    pub ok: bool,
    pub message: String,
}

/// A YAML value as JSON, with merge keys applied the way kubectl applies them.
struct Merged(Value);

impl<'de> Deserialize<'de> for Merged {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(MergedVisitor).map(Self)
    }
}

/// Merging happens while the keys arrive, because the result depends on their order
/// and a repeated `<<` would not survive in a `Map`. Scalars are read by `Value` itself.
struct MergedVisitor;

macro_rules! scalars_as_value {
    ($($method:ident: $type:ty),* $(,)?) => {$(
        fn $method<E: de::Error>(self, scalar: $type) -> Result<Value, E> {
            Value::deserialize(scalar.into_deserializer())
        }
    )*};
}

impl<'de> Visitor<'de> for MergedVisitor {
    type Value = Value;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a YAML value")
    }

    scalars_as_value!(
        visit_bool: bool,
        visit_i64: i64,
        visit_i128: i128,
        visit_u64: u64,
        visit_u128: u128,
        visit_f64: f64,
        visit_str: &str,
    );

    /// The parser reports an empty document this way.
    fn visit_none<E: de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_unit<E: de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
        let mut items = Vec::with_capacity(seq.size_hint().unwrap_or(0).min(4096));
        while let Some(Merged(item)) = seq.next_element()? {
            items.push(item);
        }
        Ok(Value::Array(items))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
        let mut object = Map::new();
        while let Some(key) = map.next_key::<String>()? {
            let Merged(value) = map.next_value()?;
            if key == MERGE_KEY {
                merge_into(&mut object, value).map_err(de::Error::custom)?;
            } else {
                object.insert(key, value);
            }
        }
        Ok(Value::Object(object))
    }
}

/// Applies what a `<<` names over the keys read so far: a key after the `<<` replaces
/// it, a key before it does not, and earlier mappings of a list beat later ones.
fn merge_into(object: &mut Map<String, Value>, sources: Value) -> Result<(), &'static str> {
    let sources = match sources {
        Value::Array(sources) => sources,
        source => vec![source],
    };
    for source in sources.into_iter().rev() {
        let Value::Object(source) = source else {
            return Err("a merge key needs a mapping or a list of mappings");
        };
        object.extend(source);
    }
    Ok(())
}

/// Parses a whole stream, leaving out empty and comment-only documents. An error
/// is a fixed message and a location, because the parser's own text quotes values.
///
/// Known differences from kubectl, which follows YAML 1.1: a plain `0644` stays the
/// text `"0644"` where kubectl has 420, and `yes` or `on` stay text where kubectl has
/// `true`. A quoted `"<<"` key also counts as a merge key here.
pub(super) fn parse_documents(yaml: &str) -> CoreResult<Vec<Value>> {
    let mut documents = Vec::new();
    for document in serde_yaml_ng::Deserializer::from_str(yaml) {
        let Merged(value) = Merged::deserialize(document)
            .map_err(|e| invalid(with_location("invalid YAML", &e)))?;
        match value {
            Value::Null => {}
            Value::Object(_) => documents.push(value),
            _ => {
                return Err(invalid(format!(
                    "invalid YAML: document {} is not a mapping",
                    documents.len() + 1
                )))
            }
        }
    }
    Ok(documents)
}

/// An identity field of another type is an error, not an absent field: an unquoted
/// `namespace: 123` must not send the object to the default namespace.
fn check_identity_types(document: &Value) -> Result<(), String> {
    for (pointer, field) in IDENTITY_FIELDS {
        match document.pointer(pointer) {
            None | Some(Value::Null | Value::String(_)) => {}
            Some(_) => return Err(format!("{field} must be a string; write it in quotes")),
        }
    }
    Ok(())
}

/// What one request has learned so far, shared by its documents.
struct ApplyRun<'a> {
    core: &'a AppCore,
    id: &'a ClusterId,
    client: Client,
    default_namespace: &'a str,
    discovery: Arc<Discovery>,
    created_crd: bool,
    /// The cluster serves something that the kept discovery does not know of.
    kept_discovery_stale: bool,
}

impl ApplyRun<'_> {
    /// Finds a kind, refreshing discovery on a miss: once, or until `ESTABLISH_LIMIT`
    /// when an earlier document created a CRD, which takes a moment to be served.
    /// A failed refresh is retried in that window while the cluster stays connected,
    /// and it is what gets reported if the last attempt was one.
    async fn resolve(
        &mut self,
        api_version: &str,
        kind: &str,
    ) -> Result<(ApiResource, ApiCapabilities), String> {
        let (group, version) = api_version.split_once('/').unwrap_or(("", api_version));
        let wanted = GroupVersionKind::gvk(group, version, kind);
        if let Some(found) = self.discovery.resolve_gvk(&wanted) {
            return Ok(found);
        }
        let deadline = Instant::now() + ESTABLISH_LIMIT;
        loop {
            let failure = match self.core.connections().rediscover(self.id).await {
                Ok(fresh) => {
                    self.discovery = Arc::new(fresh);
                    if let Some(found) = self.discovery.resolve_gvk(&wanted) {
                        self.kept_discovery_stale = true;
                        return Ok(found);
                    }
                    format!("unknown kind \"{kind}\" in apiVersion \"{api_version}\"")
                }
                Err(e) if !self.created_crd || !self.is_connected() => return Err(e.message),
                Err(e) => e.message,
            };
            if !self.created_crd || Instant::now() + ESTABLISH_POLL > deadline {
                return Err(failure);
            }
            tokio::time::sleep(ESTABLISH_POLL).await;
        }
    }

    fn is_connected(&self) -> bool {
        matches!(
            self.core.connections().state(self.id),
            ConnectionState::Connected { .. }
        )
    }

    async fn send_document(
        &mut self,
        document: &mut Value,
        result: &mut ApplyResult,
    ) -> Result<(), String> {
        check_identity_types(document)?;
        let api_version = document
            .get("apiVersion")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .ok_or("apiVersion is required")?
            .to_owned();
        let kind = result.kind.clone().ok_or("kind is required")?;
        let name = result.name.clone().ok_or("metadata.name is required")?;
        if !is_path_segment(&name) {
            return Err("metadata.name is not a valid object name".to_owned());
        }
        let (resource, capabilities) = self.resolve(&api_version, &kind).await?;
        let namespace = if capabilities.scope == Scope::Namespaced {
            let namespace = result
                .namespace
                .clone()
                .or_else(|| Some(self.default_namespace.to_owned()))
                .filter(|namespace| is_path_segment(namespace))
                .ok_or("no valid namespace is given")?;
            if let Some(metadata) = document.get_mut("metadata").and_then(Value::as_object_mut) {
                metadata.insert("namespace".to_owned(), namespace.clone().into());
            }
            Some(namespace)
        } else {
            None
        };
        result.namespace.clone_from(&namespace);

        let request = Request::new(DynamicObject::url_path(&resource, namespace.as_deref()));
        let params = PatchParams::apply(FIELD_MANAGER);
        send(
            &self.client,
            request.patch(&name, &params, &Patch::Apply(&*document)),
        )
        .await
        .map_err(|e| e.message)?;

        if resource.group == CRD_GROUP && resource.kind == CRD_KIND {
            self.created_crd = true;
            self.kept_discovery_stale = true;
        }
        Ok(())
    }

    async fn apply_document(&mut self, index: u32, mut document: Value) -> ApplyResult {
        let text = |pointer: &str| {
            document
                .pointer(pointer)
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
                .map(str::to_owned)
        };
        let mut result = ApplyResult {
            index,
            kind: text("/kind"),
            namespace: text("/metadata/namespace"),
            name: text("/metadata/name"),
            ok: false,
            message: String::new(),
        };
        match self.send_document(&mut document, &mut result).await {
            Ok(()) => {
                result.ok = true;
                "applied".clone_into(&mut result.message);
            }
            Err(message) => result.message = sanitize_text(&message),
        }
        result
    }
}

impl AppCore {
    /// Applies every document of a YAML stream, in order, with server-side apply and
    /// no force. The whole stream is parsed first, so a syntax error applies nothing;
    /// after that each document gets its own result and a failure does not stop the
    /// others. A namespaced object without a namespace goes to `default_namespace`.
    pub async fn resource_apply(
        &self,
        id: &ClusterId,
        yaml: &str,
        default_namespace: &str,
    ) -> CoreResult<Vec<ApplyResult>> {
        let documents = parse_documents(yaml)?;
        let mut run = ApplyRun {
            core: self,
            id,
            client: self.cluster_client(id)?,
            default_namespace,
            discovery: self.cluster_discovery(id)?,
            created_crd: false,
            kept_discovery_stale: false,
        };
        let mut results = Vec::with_capacity(documents.len());
        for (index, document) in (0u32..).zip(documents) {
            results.push(run.apply_document(index, document).await);
        }
        if run.kept_discovery_stale {
            // The documents did get applied, so this does not fail the request.
            if let Err(e) = self.resources_discover(id, true).await {
                tracing::warn!("discovery refresh after apply failed: {}", e.message);
            }
        }
        Ok(results)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    #[test]
    fn parse_skips_what_is_empty() {
        assert!(parse_documents("").unwrap().is_empty());
        assert!(parse_documents("# only a comment\n").unwrap().is_empty());
        let documents = parse_documents("---\n---\n# note\n---\na: 1\n---\n").unwrap();
        assert_eq!(documents, [serde_json::json!({ "a": 1 })]);
    }

    #[test]
    fn parse_errors_locate_and_do_not_quote() {
        let err = parse_documents("a: 1\n---\nb: [tok-SECRET\n").unwrap_err();
        assert!(
            err.message.starts_with("invalid YAML at line "),
            "{}",
            err.message
        );
        assert!(!err.message.contains("tok-SECRET"), "{}", err.message);
    }

    #[test]
    fn parse_rejects_a_document_that_is_not_a_mapping() {
        for text in ["tok-SECRET", "- tok-SECRET", "a: 1\n---\n7\n"] {
            let err = parse_documents(text).unwrap_err();
            assert!(err.message.contains("not a mapping"), "{}", err.message);
            assert!(!err.message.contains("tok-SECRET"), "{}", err.message);
        }
    }

    /// Expected values come from `kubectl create --dry-run=client --validate=false -o json`.
    #[test]
    fn parse_applies_merge_keys_as_kubectl_does() {
        let anchors = "x-a: &a {k: from-a, only-a: a}\nx-b: &b {k: from-b, only-b: b}\n";
        for (data, expected) in [
            (
                "<<: *a",
                serde_json::json!({ "k": "from-a", "only-a": "a" }),
            ),
            (
                "<<: *a\n  k: explicit",
                serde_json::json!({ "k": "explicit", "only-a": "a" }),
            ),
            (
                "k: explicit\n  <<: *a",
                serde_json::json!({ "k": "from-a", "only-a": "a" }),
            ),
            (
                "<<: [*a, *b]",
                serde_json::json!({ "k": "from-a", "only-a": "a", "only-b": "b" }),
            ),
            (
                "<<: *a\n  <<: *b",
                serde_json::json!({ "k": "from-b", "only-a": "a", "only-b": "b" }),
            ),
            ("<<: {k: inline}", serde_json::json!({ "k": "inline" })),
            ("<<: []\n  k: v", serde_json::json!({ "k": "v" })),
        ] {
            let documents = parse_documents(&format!("{anchors}data:\n  {data}\n")).unwrap();
            assert_eq!(documents[0]["data"], expected, "{data}");
        }
    }

    #[test]
    fn parse_applies_merge_keys_at_any_depth() {
        let text = "x-a: &a {k: v}\nx-c: &c\n  <<: *a\n  c: c\nnested:\n  <<: *c\nlist:\n  - <<: *a\n    z: 1\n";
        let documents = parse_documents(text).unwrap();
        assert_eq!(
            documents[0]["nested"],
            serde_json::json!({ "k": "v", "c": "c" })
        );
        assert_eq!(
            documents[0]["list"],
            serde_json::json!([{ "k": "v", "z": 1 }])
        );
    }

    #[test]
    fn parse_rejects_a_merge_key_that_is_not_a_mapping() {
        for data in ["<<: tok-SECRET", "<<:\n  k: v", "<<: [{k: v}, tok-SECRET]"] {
            let err = parse_documents(&format!("data:\n  {data}\n")).unwrap_err();
            assert_eq!(err.code, ErrorCode::InvalidInput);
            assert!(
                err.message.starts_with("invalid YAML at line 2, column "),
                "{}",
                err.message
            );
            assert!(!err.message.contains("tok-SECRET"), "{}", err.message);
        }
    }

    /// Without a merge key, the result is what `serde_json::Value` alone reads.
    #[test]
    fn parse_reads_everything_else_like_a_plain_json_value() {
        let plain = |text| {
            serde_yaml_ng::Deserializer::from_str(text)
                .map(|document| Value::deserialize(document).ok())
                .collect::<Vec<_>>()
        };
        let merged = |text| {
            serde_yaml_ng::Deserializer::from_str(text)
                .map(|document| Merged::deserialize(document).ok().map(|merged| merged.0))
                .collect::<Vec<_>>()
        };
        for text in [
            "",
            "---\n",
            "---\n---\n# note\n---\n",
            "s: text\nquoted: \"1\"\nt: true\nn: ~\nblank:\nint: -7\nfloat: 1.5\ninf: .inf\n",
            "u64: 18446744073709551615\nu128: 18446744073709551616\ni128: -9223372036854775809\n",
            "too-big: 340282366920938463463374607431768211456\n",
            "list: [1, a, {b: c}, [], {}]\n1: int key\ntrue: bool key\n~: null key\n",
            "repeated: first\nrepeated: last\nanchor: &x {a: 1}\nalias: *x\n",
            "tagged: !custom value\n",
            "typed: !!str 1\n",
            "{a: 1}: mapping key\n",
        ] {
            assert_eq!(merged(text), plain(text), "{text}");
        }
        assert_eq!(
            parse_documents("repeated: first\nrepeated: last\n").unwrap()[0]["repeated"],
            "last"
        );
    }

    /// These read differently from kubectl. The parser hands over plain and quoted text
    /// the same way, so they cannot be told apart here. The test pins today's behaviour;
    /// it does not say that this is wanted.
    #[test]
    fn parse_differs_from_kubectl_on_these_scalars() {
        let documents = parse_documents("octal: 0644\nprefixed: 0o644\nyes: yes\n").unwrap();
        assert_eq!(documents[0]["octal"], "0644");
        assert_eq!(documents[0]["prefixed"], 420);
        assert_eq!(documents[0]["yes"], "yes");
        assert!(parse_documents("\"<<\": text\n").is_err());
    }
}
