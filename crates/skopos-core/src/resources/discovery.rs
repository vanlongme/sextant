//! What the cluster serves, at the preferred version of each API group.

use std::collections::HashMap;
use std::sync::Arc;

use futures::stream::{self, StreamExt};
use kube::core::discovery::Scope as ApiScope;
use kube::{Client, Discovery};

use super::access::{check_access, Scope, Served};
use super::types::{ApiResourceInfo, ResourceRef};
use crate::app_core::AppCore;
use crate::cluster::ConnectionState;
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::kubeconfig::ClusterId;

const MAX_IN_FLIGHT: usize = 10;

pub(super) fn state_name(state: &ConnectionState) -> &'static str {
    match state {
        ConnectionState::Disconnected => "disconnected",
        ConnectionState::Connecting => "still connecting",
        ConnectionState::Connected { .. } => "connected",
        ConnectionState::Failed { .. } => "in a failed state",
    }
}

/// Resources with a `list` verb, without subresources, one entry per group and plural.
pub(super) fn served_resources(discovery: &Discovery) -> Vec<Served> {
    let mut served = Vec::new();
    for group in discovery.groups() {
        for (resource, capabilities) in group.recommended_resources() {
            if resource.plural.contains('/') || !capabilities.supports_operation("list") {
                continue;
            }
            served.push(Served {
                resource: ResourceRef {
                    group: resource.group,
                    version: resource.version,
                    plural: resource.plural,
                    kind: resource.kind,
                    namespaced: capabilities.scope == ApiScope::Namespaced,
                },
                verbs: capabilities.operations,
                short_names: Vec::new(),
            });
        }
    }
    served.sort_by(|a, b| {
        (&a.resource.group, &a.resource.plural).cmp(&(&b.resource.group, &b.resource.plural))
    });
    served
}

/// Discovery documents of the kube client drop short names, so they are read
/// from the group-version documents. A group that does not answer has none.
async fn fill_short_names(client: &Client, served: &mut [Served]) {
    let mut versions: Vec<(String, String)> = served
        .iter()
        .map(|s| (s.resource.group.clone(), s.resource.version.clone()))
        .collect();
    versions.sort();
    versions.dedup();
    let lists: HashMap<_, _> = stream::iter(versions)
        .map(|(group, version)| async move {
            let list = if group.is_empty() {
                client.list_core_api_resources(&version).await
            } else {
                client
                    .list_api_group_resources(&format!("{group}/{version}"))
                    .await
            };
            let names = list.map_or_else(
                |_| HashMap::new(),
                |list| {
                    list.resources
                        .into_iter()
                        .filter_map(|r| r.short_names.map(|names| (r.name, names)))
                        .collect()
                },
            );
            ((group, version), names)
        })
        .buffer_unordered(MAX_IN_FLIGHT)
        .collect()
        .await;
    for entry in served {
        let key = (entry.resource.group.clone(), entry.resource.version.clone());
        if let Some(names) = lists
            .get(&key)
            .and_then(|names| names.get(&entry.resource.plural))
        {
            entry.short_names.clone_from(names);
        }
    }
}

impl AppCore {
    /// The resources the cluster serves and what the user may do with each.
    /// The result is kept until the cluster disconnects; `refresh` runs discovery
    /// and the access checks again and replaces `cluster_discovery`'s answer.
    pub async fn resources_discover(
        &self,
        id: &ClusterId,
        refresh: bool,
    ) -> CoreResult<Vec<ApiResourceInfo>> {
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
        if !refresh {
            if let Some(cached) = connections.cached_resources(id)? {
                return Ok(cached.as_ref().clone());
            }
        }
        let epoch = connections.epoch(id)?;
        let client = self.cluster_client(id)?;
        let fresh = if refresh {
            Some(connections.rediscover(id).await?)
        } else {
            None
        };
        let current;
        let discovery = match &fresh {
            Some(fresh) => fresh,
            None => {
                current = self.cluster_discovery(id)?;
                current.as_ref()
            }
        };
        let mut served = served_resources(discovery);
        fill_short_names(&client, &mut served).await;
        let scope = Scope {
            namespaces: &info.namespaces,
            restricted: info.namespaces_restricted,
        };
        let resources = check_access(&client, served, &scope).await;
        connections.store_resources(id, epoch, fresh, Arc::new(resources.clone()));
        Ok(resources)
    }
}
