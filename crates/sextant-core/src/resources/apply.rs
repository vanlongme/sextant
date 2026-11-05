//! Applies a stream of YAML documents with server-side apply, each on its own.

use std::sync::Arc;
use std::time::Duration;

use kube::api::{DynamicObject, Patch, PatchParams};
use kube::core::discovery::{ApiCapabilities, Scope};
use kube::core::{ApiResource, GroupVersionKind, Request, Resource};
use kube::{Client, Discovery};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::time::Instant;
use ts_rs::TS;

use super::ops::{invalid, is_path_segment, send};
use crate::app_core::AppCore;
use crate::error::{sanitize_text, CoreResult};
use crate::kubeconfig::{with_location, ClusterId};

const FIELD_MANAGER: &str = "sextant";
const CRD_GROUP: &str = "apiextensions.k8s.io";
const CRD_KIND: &str = "CustomResourceDefinition";
/// How long a kind may stay unknown after a CRD in the same request was applied.
const ESTABLISH_LIMIT: Duration = Duration::from_secs(10);
const ESTABLISH_POLL: Duration = Duration::from_millis(500);

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

/// Parses a whole stream, leaving out empty and comment-only documents. An error
/// is a fixed message and a location, because the parser's own text quotes values.
pub(super) fn parse_documents(yaml: &str) -> CoreResult<Vec<Value>> {
    let mut documents = Vec::new();
    for document in serde_yaml_ng::Deserializer::from_str(yaml) {
        let value =
            Value::deserialize(document).map_err(|e| invalid(with_location("invalid YAML", &e)))?;
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
            match self.core.connections().rediscover(self.id).await {
                Ok(fresh) => {
                    self.discovery = Arc::new(fresh);
                    if let Some(found) = self.discovery.resolve_gvk(&wanted) {
                        self.kept_discovery_stale = true;
                        return Ok(found);
                    }
                }
                Err(e) if !self.created_crd => return Err(e.message),
                Err(_) => {}
            }
            if !self.created_crd || Instant::now() + ESTABLISH_POLL > deadline {
                return Err(format!(
                    "unknown kind \"{kind}\" in apiVersion \"{api_version}\""
                ));
            }
            tokio::time::sleep(ESTABLISH_POLL).await;
        }
    }

    async fn send_document(
        &mut self,
        document: &mut Value,
        result: &mut ApplyResult,
    ) -> Result<(), String> {
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
}
