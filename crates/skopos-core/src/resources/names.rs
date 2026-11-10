//! The names of a fixed set of kinds, which the command palette searches (spec C §10.1).

use std::sync::Arc;
use std::time::Duration;

use futures::stream::{self, StreamExt};
use kube::api::ListParams;
use kube::Client;
use serde::Serialize;
use serde_json::Value;
use ts_rs::TS;

use super::discovery::{served_resources, state_name};
use super::ops::{resource_request, send};
use super::types::ResourceRef;
use crate::app_core::AppCore;
use crate::cluster::ConnectionState;
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::kubeconfig::ClusterId;

/// The kinds, in the palette's order, as (API group, plural).
const KINDS: [(&str, &str); 14] = [
    ("", "pods"),
    ("apps", "deployments"),
    ("apps", "statefulsets"),
    ("apps", "daemonsets"),
    ("apps", "replicasets"),
    ("batch", "jobs"),
    ("batch", "cronjobs"),
    ("", "services"),
    ("networking.k8s.io", "ingresses"),
    ("", "configmaps"),
    ("", "secrets"),
    ("", "persistentvolumeclaims"),
    ("", "nodes"),
    ("", "namespaces"),
];

/// How long an answer is kept for a connection.
pub(crate) const NAMES_TTL: Duration = Duration::from_secs(30);
/// The most names read for one kind.
const LIMIT: usize = 2000;
/// The namespaces tried when a cluster-wide list is forbidden.
const MAX_NAMESPACES: usize = 20;
/// Requests in flight at once.
const IN_FLIGHT: usize = 4;
/// The limit on each request.
const REQUEST_LIMIT: Duration = Duration::from_secs(10);

/// One object the palette can open.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ObjectName {
    pub kind: String,
    pub group: String,
    pub plural: String,
    pub namespace: Option<String>,
    pub name: String,
}

/// The names of the palette's kinds, and the plurals cut at 2,000.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ObjectNames {
    pub items: Vec<ObjectName>,
    pub truncated: Vec<String>,
}

/// What reading one kind gave.
enum KindRead {
    Read {
        items: Vec<ObjectName>,
        truncated: bool,
    },
    /// Forbidden or not found everywhere it was tried.
    Skipped,
    Failed(IpcError),
}

fn is_skipped(error: &IpcError) -> bool {
    matches!(error.code, ErrorCode::Forbidden | ErrorCode::NotFound)
}

fn name_of(r: &ResourceRef, item: &Value) -> Option<ObjectName> {
    let metadata = &item["metadata"];
    Some(ObjectName {
        kind: r.kind.clone(),
        group: r.group.clone(),
        plural: r.plural.clone(),
        namespace: metadata["namespace"].as_str().map(str::to_owned),
        name: metadata["name"].as_str()?.to_owned(),
    })
}

/// One metadata-only page of at most `limit` names, and whether the server has more.
async fn list_names(
    client: &Client,
    r: &ResourceRef,
    namespace: Option<&str>,
    limit: usize,
) -> CoreResult<(Vec<ObjectName>, bool)> {
    let params = ListParams::default().limit(u32::try_from(limit).unwrap_or(u32::MAX));
    let request = resource_request(r, namespace)?.list_metadata(&params);
    let answer = tokio::time::timeout(REQUEST_LIMIT, send(client, request))
        .await
        .map_err(|_| {
            IpcError::new(
                ErrorCode::Unreachable,
                format!("listing {} timed out after {REQUEST_LIMIT:?}", r.plural),
            )
        })??;
    let more = answer["metadata"]["continue"]
        .as_str()
        .is_some_and(|token| !token.is_empty());
    let items = answer["items"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| name_of(r, item))
                .take(limit)
                .collect()
        })
        .unwrap_or_default();
    Ok((items, more))
}

/// Reads one kind cluster-wide, or namespace by namespace when that is forbidden.
async fn read_kind(client: &Client, r: &ResourceRef, namespaces: &[String]) -> KindRead {
    let error = match list_names(client, r, None, LIMIT).await {
        Ok((items, truncated)) => return KindRead::Read { items, truncated },
        Err(error) => error,
    };
    if !r.namespaced || error.code != ErrorCode::Forbidden {
        return if is_skipped(&error) {
            KindRead::Skipped
        } else {
            KindRead::Failed(error)
        };
    }
    let mut items = Vec::new();
    let mut truncated = false;
    let mut read_any = false;
    let mut failure = None;
    for namespace in namespaces.iter().take(MAX_NAMESPACES) {
        let left = LIMIT - items.len();
        if left == 0 {
            truncated = true;
            break;
        }
        match list_names(client, r, Some(namespace), left).await {
            Ok((names, more)) => {
                read_any = true;
                truncated |= more;
                items.extend(names);
            }
            Err(error) if is_skipped(&error) => {}
            Err(error) => {
                failure.get_or_insert(error);
            }
        }
    }
    match (read_any, failure) {
        (true, _) => KindRead::Read { items, truncated },
        (false, Some(error)) => KindRead::Failed(error),
        (false, None) => KindRead::Skipped,
    }
}

/// Puts the kinds together in order. The answer fails only when no kind was read
/// and something other than a 403 or 404 went wrong; it is then the first such
/// failure in kind order.
fn combine(kinds: &[ResourceRef], reads: Vec<KindRead>) -> CoreResult<ObjectNames> {
    let mut names = ObjectNames {
        items: Vec::new(),
        truncated: Vec::new(),
    };
    let mut read_any = false;
    let mut failure = None;
    for (r, read) in kinds.iter().zip(reads) {
        match read {
            KindRead::Read { items, truncated } => {
                read_any = true;
                names.items.extend(items);
                if truncated {
                    names.truncated.push(r.plural.clone());
                }
            }
            KindRead::Skipped => {}
            KindRead::Failed(error) => {
                failure.get_or_insert(error);
            }
        }
    }
    match failure {
        Some(error) if !read_any => Err(error),
        _ => Ok(names),
    }
}

impl AppCore {
    /// The names of the palette's 14 kinds on a connected cluster, kept for 30 s.
    /// A disconnect or reconnect drops the kept answer with the connection.
    pub async fn resources_names(&self, id: &ClusterId) -> CoreResult<ObjectNames> {
        let info = match self.cluster_state(id) {
            ConnectionState::Connected { info } => info,
            other => {
                return Err(IpcError::new(
                    ErrorCode::InvalidInput,
                    format!("cluster {id} is {}", state_name(&other)),
                ))
            }
        };
        let connections = self.connections();
        if let Some(cached) = connections.cached_names(id)? {
            return Ok(cached.as_ref().clone());
        }
        let epoch = connections.epoch(id)?;
        let client = self.cluster_client(id)?;
        let discovery = self.cluster_discovery(id)?;
        let served = served_resources(&discovery);
        let kinds: Vec<ResourceRef> = KINDS
            .iter()
            .filter_map(|(group, plural)| {
                served
                    .iter()
                    .find(|s| s.resource.group == *group && s.resource.plural == *plural)
                    .map(|s| s.resource.clone())
            })
            .collect();
        // Owned futures: borrowing `client` into a stream closure makes the command's
        // future fail the higher-ranked `Send` check.
        let namespaces = Arc::new(info.namespaces);
        let reads: Vec<KindRead> = stream::iter(kinds.iter().cloned().map(|r| {
            let client = client.clone();
            let namespaces = namespaces.clone();
            async move { read_kind(&client, &r, &namespaces).await }
        }))
        .buffered(IN_FLIGHT)
        .collect()
        .await;
        let names = combine(&kinds, reads)?;
        connections.store_names(id, epoch, Arc::new(names.clone()));
        Ok(names)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kind(plural: &str) -> ResourceRef {
        ResourceRef {
            group: String::new(),
            version: "v1".into(),
            plural: plural.into(),
            kind: plural.into(),
            namespaced: true,
        }
    }

    fn read(plural: &str, name: &str, truncated: bool) -> KindRead {
        KindRead::Read {
            items: vec![ObjectName {
                kind: plural.into(),
                group: String::new(),
                plural: plural.into(),
                namespace: Some("default".into()),
                name: name.into(),
            }],
            truncated,
        }
    }

    fn failed(message: &str) -> KindRead {
        KindRead::Failed(IpcError::new(ErrorCode::Internal, message))
    }

    #[test]
    fn the_kinds_follow_the_spec() {
        assert_eq!(
            KINDS.map(|(_, plural)| plural),
            [
                "pods",
                "deployments",
                "statefulsets",
                "daemonsets",
                "replicasets",
                "jobs",
                "cronjobs",
                "services",
                "ingresses",
                "configmaps",
                "secrets",
                "persistentvolumeclaims",
                "nodes",
                "namespaces",
            ]
        );
    }

    #[test]
    fn keeps_the_kinds_in_order_and_names_the_truncated_ones() {
        let names = combine(
            &[kind("pods"), kind("secrets")],
            vec![read("pods", "a", false), read("secrets", "b", true)],
        )
        .unwrap();
        let read: Vec<&str> = names.items.iter().map(|o| o.name.as_str()).collect();
        assert_eq!(read, ["a", "b"]);
        assert_eq!(names.truncated, ["secrets"]);
    }

    #[test]
    fn a_failure_beside_a_read_kind_is_dropped() {
        let names = combine(
            &[kind("pods"), kind("jobs")],
            vec![failed("down"), read("jobs", "a", false)],
        )
        .unwrap();
        assert_eq!(names.items.len(), 1);
    }

    #[test]
    fn with_nothing_read_the_first_failure_is_the_answer() {
        let error = combine(
            &[kind("pods"), kind("jobs"), kind("secrets")],
            vec![KindRead::Skipped, failed("first"), failed("second")],
        )
        .unwrap_err();
        assert_eq!(error.message, "first");
    }

    #[test]
    fn skipped_kinds_alone_give_an_empty_answer() {
        let names = combine(&[kind("pods")], vec![KindRead::Skipped]).unwrap();
        assert!(names.items.is_empty() && names.truncated.is_empty());
    }
}
