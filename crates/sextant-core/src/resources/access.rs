//! Access checks: which verbs the user may use on each resource.

use std::time::Duration;

use futures::stream::{self, StreamExt};
use k8s_openapi::api::authorization::v1::{
    ResourceAttributes, SelfSubjectAccessReview, SelfSubjectAccessReviewSpec,
};
use kube::api::{Api, PostParams};
use kube::Client;

use super::types::{ApiResourceInfo, ResourceRef};
use crate::error::sanitize_text;

const VERBS: [&str; 5] = ["list", "watch", "create", "update", "delete"];
const MAX_IN_FLIGHT: usize = 10;
const MAX_NAMESPACES: usize = 20;
const REVIEW_LIMIT: Duration = Duration::from_secs(10);

/// A served resource before its access is known.
pub(super) struct Served {
    pub resource: ResourceRef,
    pub verbs: Vec<String>,
    pub short_names: Vec<String>,
}

/// The namespaces to try when a cluster-wide review denies.
pub(super) struct Scope<'a> {
    pub namespaces: &'a [String],
    pub restricted: bool,
}

#[derive(Default)]
struct Failures {
    count: usize,
    first: Option<String>,
}

enum Answer {
    Allowed,
    Denied,
    /// The review itself failed. The API server still enforces access, so the
    /// caller treats this as allowed rather than hiding everything.
    Failed(String),
}

async fn review(
    client: &Client,
    resource: &ResourceRef,
    verb: &str,
    namespace: Option<&str>,
) -> Answer {
    let review = SelfSubjectAccessReview {
        spec: SelfSubjectAccessReviewSpec {
            resource_attributes: Some(ResourceAttributes {
                group: Some(resource.group.clone()),
                resource: Some(resource.plural.clone()),
                verb: Some(verb.to_owned()),
                namespace: namespace.map(str::to_owned),
                ..Default::default()
            }),
            ..Default::default()
        },
        ..Default::default()
    };
    let api = Api::<SelfSubjectAccessReview>::all(client.clone());
    match tokio::time::timeout(REVIEW_LIMIT, api.create(&PostParams::default(), &review)).await {
        Ok(Ok(done)) => {
            if done.status.is_some_and(|status| status.allowed) {
                Answer::Allowed
            } else {
                Answer::Denied
            }
        }
        Ok(Err(e)) => Answer::Failed(e.to_string()),
        Err(_) => Answer::Failed(format!("timed out after {REVIEW_LIMIT:?}")),
    }
}

/// Allowed cluster-wide, or, given a scope, in any accessible namespace.
async fn allowed(
    client: &Client,
    resource: &ResourceRef,
    verb: &str,
    scope: Option<&Scope<'_>>,
) -> (bool, Option<String>) {
    match review(client, resource, verb, None).await {
        Answer::Allowed => return (true, None),
        Answer::Failed(e) => return (true, Some(e)),
        Answer::Denied => {}
    }
    let Some(scope) = scope.filter(|scope| scope.restricted || resource.namespaced) else {
        return (false, None);
    };
    for namespace in scope.namespaces.iter().take(MAX_NAMESPACES) {
        match review(client, resource, verb, Some(namespace)).await {
            Answer::Allowed => return (true, None),
            Answer::Failed(e) => return (true, Some(e)),
            Answer::Denied => {}
        }
    }
    (false, None)
}

/// Reviews every served resource for the five verbs, at most `MAX_IN_FLIGHT`
/// reviews at a time. A verb the resource does not serve is not allowed.
pub(super) async fn check_access(
    client: &Client,
    served: Vec<Served>,
    scope: &Scope<'_>,
) -> Vec<ApiResourceInfo> {
    let jobs: Vec<(usize, usize)> = (0..served.len())
        .flat_map(|r| (0..VERBS.len()).map(move |v| (r, v)))
        .collect();
    let served_ref = &served;
    let results: Vec<(bool, Option<String>)> = stream::iter(jobs)
        .map(|(r, v)| async move {
            let entry = &served_ref[r];
            let verb = VERBS[v];
            if !entry.verbs.iter().any(|served| served == verb) {
                return (false, None);
            }
            // Reading works through a narrower scope, and so does deleting a
            // namespaced object: delete is offered when any accessible namespace
            // allows it, and the API server answers for each object. Create and
            // update are offered only when allowed cluster-wide.
            let scope = match verb {
                "list" | "watch" => Some(scope),
                "delete" if entry.resource.namespaced => Some(scope),
                _ => None,
            };
            allowed(client, &entry.resource, verb, scope).await
        })
        .buffered(MAX_IN_FLIGHT)
        .collect()
        .await;

    let mut failures = Failures::default();
    for (_, error) in &results {
        if let Some(error) = error {
            failures.count += 1;
            failures.first.get_or_insert_with(|| error.clone());
        }
    }
    if let Some(first) = failures.first {
        tracing::warn!(
            "{} access reviews failed and were treated as allowed; first error: {}",
            failures.count,
            sanitize_text(&first)
        );
    }

    served
        .into_iter()
        .enumerate()
        .map(|(r, entry)| {
            let flag = |v: usize| results[r * VERBS.len() + v].0;
            ApiResourceInfo {
                resource: entry.resource,
                verbs: entry.verbs,
                short_names: entry.short_names,
                can_list: flag(0),
                can_watch: flag(1),
                can_create: flag(2),
                can_update: flag(3),
                can_delete: flag(4),
            }
        })
        .collect()
}
