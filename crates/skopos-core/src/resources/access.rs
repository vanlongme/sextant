//! Access checks: which verbs the user may use on each resource.
//!
//! A cluster with hundreds of kinds would need thousands of SelfSubjectAccessReviews, one per
//! kind and verb, so three cheaper answers come first:
//! 1. One review for every verb on every resource: when it allows, as for cluster-admin, all
//!    is allowed.
//! 2. One SelfSubjectRulesReview per namespace in scope. Its rules answer for namespaced kinds,
//!    and when every namespace listed all of its rules, a verb no rule grants is denied.
//! 3. A per-verb review for the rest, as before.

use std::time::Duration;

use futures::stream::{self, StreamExt};
use k8s_openapi::api::authorization::v1::{
    ResourceAttributes, ResourceRule, SelfSubjectAccessReview, SelfSubjectAccessReviewSpec,
    SelfSubjectRulesReview, SelfSubjectRulesReviewSpec,
};
use kube::api::{Api, PostParams};
use kube::Client;

use super::types::{ApiResourceInfo, ResourceRef};
use crate::error::sanitize_text;

const VERBS: [&str; 6] = ["list", "watch", "create", "update", "patch", "delete"];
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
    ask(
        client,
        ResourceAttributes {
            group: Some(resource.group.clone()),
            resource: Some(resource.plural.clone()),
            verb: Some(verb.to_owned()),
            namespace: namespace.map(str::to_owned),
            ..Default::default()
        },
    )
    .await
}

/// Whether a cluster-wide review allows every verb on every resource, as for cluster-admin.
async fn allowed_everything(client: &Client) -> bool {
    let everything = ResourceAttributes {
        group: Some("*".to_owned()),
        resource: Some("*".to_owned()),
        verb: Some("*".to_owned()),
        ..Default::default()
    };
    matches!(ask(client, everything).await, Answer::Allowed)
}

async fn ask(client: &Client, attributes: ResourceAttributes) -> Answer {
    let review = SelfSubjectAccessReview {
        spec: SelfSubjectAccessReviewSpec {
            resource_attributes: Some(attributes),
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

/// What one namespace's SelfSubjectRulesReview granted. `complete` is false when an
/// authorizer, such as a webhook, could not list its rules: a verb missing from `rules` may
/// still be allowed.
struct NamespaceRules {
    rules: Vec<ResourceRule>,
    complete: bool,
}

/// What the rules of the namespaces in scope say about one verb on one kind.
#[derive(Debug, PartialEq, Eq)]
enum RulesAnswer {
    /// A rule in some namespace grants it.
    Granted,
    /// Every namespace in scope listed all of its rules, and none grants it. Rules from
    /// ClusterRoleBindings are listed in every namespace, so no cluster-wide grant exists either.
    Refused,
    /// Only a SelfSubjectAccessReview can tell.
    Unknown,
}

/// The rules reviews of the namespaces in scope, `None` where a review failed.
struct ScopeRules(Vec<Option<NamespaceRules>>);

impl ScopeRules {
    fn answer(&self, resource: &ResourceRef, verb: &str) -> RulesAnswer {
        if self.0.is_empty() {
            return RulesAnswer::Unknown;
        }
        let mut complete = true;
        for namespace in &self.0 {
            let Some(namespace) = namespace else {
                complete = false;
                continue;
            };
            if namespace
                .rules
                .iter()
                .any(|rule| grants(rule, resource, verb))
            {
                return RulesAnswer::Granted;
            }
            complete &= namespace.complete;
        }
        if complete {
            RulesAnswer::Refused
        } else {
            RulesAnswer::Unknown
        }
    }
}

/// Whether `rule` grants `verb` on every object of the kind. A rule limited to named objects
/// does not: it allows neither list nor create.
fn grants(rule: &ResourceRule, resource: &ResourceRef, verb: &str) -> bool {
    let names = |list: Option<&Vec<String>>, value: &str| {
        list.is_some_and(|list| list.iter().any(|v| v == "*" || v == value))
    };
    rule.resource_names.as_ref().is_none_or(Vec::is_empty)
        && rule.verbs.iter().any(|v| v == "*" || v == verb)
        && names(rule.api_groups.as_ref(), &resource.group)
        && names(rule.resources.as_ref(), &resource.plural)
}

async fn rules_review(client: &Client, namespace: &str) -> Result<NamespaceRules, String> {
    let review = SelfSubjectRulesReview {
        spec: SelfSubjectRulesReviewSpec {
            namespace: Some(namespace.to_owned()),
        },
        ..Default::default()
    };
    let api = Api::<SelfSubjectRulesReview>::all(client.clone());
    match tokio::time::timeout(REVIEW_LIMIT, api.create(&PostParams::default(), &review)).await {
        Ok(Ok(done)) => {
            let Some(status) = done.status else {
                return Err("the rules review came back without a status".to_owned());
            };
            let complete =
                !status.incomplete && status.evaluation_error.as_deref().is_none_or(str::is_empty);
            Ok(NamespaceRules {
                rules: status.resource_rules,
                complete,
            })
        }
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err(format!("timed out after {REVIEW_LIMIT:?}")),
    }
}

/// One rules review per namespace in scope, the same namespaces `allowed` would try.
async fn scope_rules(client: &Client, scope: &Scope<'_>) -> ScopeRules {
    // Owned names: a closure over `&String` makes the future `Send` only for one lifetime,
    // and Tauri commands need it for every lifetime.
    let results: Vec<Result<NamespaceRules, String>> =
        stream::iter(scope.namespaces.iter().take(MAX_NAMESPACES).cloned())
            .map(|namespace| async move { rules_review(client, &namespace).await })
            .buffered(MAX_IN_FLIGHT)
            .collect()
            .await;
    let mut failures = Failures::default();
    let rules = results
        .into_iter()
        .map(|result| {
            result
                .map_err(|error| {
                    failures.count += 1;
                    failures.first.get_or_insert(error);
                })
                .ok()
        })
        .collect();
    if let Some(first) = failures.first {
        tracing::warn!(
            "{} rules reviews failed, so their namespaces are checked one verb at a time; first error: {}",
            failures.count,
            sanitize_text(&first)
        );
    }
    ScopeRules(rules)
}

fn info(entry: Served, flags: [bool; 6]) -> ApiResourceInfo {
    let [can_list, can_watch, can_create, can_update, can_patch, can_delete] = flags;
    ApiResourceInfo {
        resource: entry.resource,
        verbs: entry.verbs,
        short_names: entry.short_names,
        can_list,
        can_watch,
        can_create,
        can_update,
        can_patch,
        can_delete,
    }
}

/// Finds which verbs in `VERBS` the user may use on every served resource. A verb the
/// resource does not serve is not allowed. At most `MAX_IN_FLIGHT` reviews run at a time.
pub(super) async fn check_access(
    client: &Client,
    served: Vec<Served>,
    scope: &Scope<'_>,
) -> Vec<ApiResourceInfo> {
    if allowed_everything(client).await {
        return served
            .into_iter()
            .map(|entry| {
                let flags = VERBS.map(|verb| entry.verbs.iter().any(|served| served == verb));
                info(entry, flags)
            })
            .collect();
    }
    let rules = scope_rules(client, scope).await;

    let jobs: Vec<(usize, usize)> = (0..served.len())
        .flat_map(|r| (0..VERBS.len()).map(move |v| (r, v)))
        .collect();
    let served_ref = &served;
    let rules_ref = &rules;
    let results: Vec<(bool, Option<String>)> = stream::iter(jobs)
        .map(|(r, v)| async move {
            let entry = &served_ref[r];
            let verb = VERBS[v];
            if !entry.verbs.iter().any(|served| served == verb) {
                return (false, None);
            }
            // A rule naming a cluster-scoped kind may come from a RoleBinding, which grants
            // nothing on it, so only a refusal settles a cluster-scoped kind.
            match rules_ref.answer(&entry.resource, verb) {
                RulesAnswer::Granted if entry.resource.namespaced => return (true, None),
                RulesAnswer::Refused => return (false, None),
                RulesAnswer::Granted | RulesAnswer::Unknown => {}
            }
            // The API server answers for each object, so an action on a namespaced kind is
            // offered when any accessible namespace allows it. Reading works through a narrower
            // scope too. A review naming a namespace says nothing about a cluster-scoped object.
            let scope = match verb {
                "list" | "watch" => Some(scope),
                "create" | "update" | "patch" | "delete" if entry.resource.namespaced => {
                    Some(scope)
                }
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
            let flags = std::array::from_fn(|v| results[r * VERBS.len() + v].0);
            info(entry, flags)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Tauri commands await `check_access` on a multi-threaded runtime, so its future must
    /// be `Send` whatever the borrows' lifetimes. This fails to compile when it is not.
    #[allow(dead_code)]
    fn check_access_is_send<'a>(client: &'a Client, scope: &'a Scope<'a>) {
        fn send<T: Send>(_: &T) {}
        send(&check_access(client, Vec::new(), scope));
    }

    fn kind(group: &str, plural: &str) -> ResourceRef {
        ResourceRef {
            group: group.to_owned(),
            version: "v1".to_owned(),
            plural: plural.to_owned(),
            kind: "Kind".to_owned(),
            namespaced: true,
        }
    }

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| (*v).to_owned()).collect()
    }

    fn rule(groups: &[&str], resources: &[&str], verbs: &[&str]) -> ResourceRule {
        ResourceRule {
            api_groups: Some(strings(groups)),
            resources: Some(strings(resources)),
            verbs: strings(verbs),
            resource_names: None,
        }
    }

    fn namespace(rules: Vec<ResourceRule>, complete: bool) -> Option<NamespaceRules> {
        Some(NamespaceRules { rules, complete })
    }

    #[test]
    fn a_rule_grants_its_group_kind_and_verb_or_a_wildcard() {
        let pods = kind("", "pods");
        assert!(grants(&rule(&[""], &["pods"], &["list"]), &pods, "list"));
        assert!(grants(&rule(&["*"], &["*"], &["*"]), &pods, "delete"));
        assert!(!grants(&rule(&[""], &["pods"], &["list"]), &pods, "delete"));
        assert!(!grants(
            &rule(&["apps"], &["pods"], &["list"]),
            &pods,
            "list"
        ));
        assert!(!grants(&rule(&[""], &["pods/log"], &["get"]), &pods, "get"));
        let no_groups = ResourceRule {
            api_groups: None,
            ..rule(&[], &["pods"], &["list"])
        };
        assert!(!grants(&no_groups, &pods, "list"));
    }

    #[test]
    fn a_rule_for_named_objects_grants_nothing_on_the_kind() {
        let named = ResourceRule {
            resource_names: Some(strings(&["app-config"])),
            ..rule(&[""], &["configmaps"], &["get", "list", "delete"])
        };
        assert!(!grants(&named, &kind("", "configmaps"), "list"));
    }

    #[test]
    fn rules_refuse_only_when_every_namespace_listed_all_of_its_rules() {
        let pods = kind("", "pods");
        let read = || rule(&[""], &["pods"], &["list"]);

        let granted = ScopeRules(vec![
            namespace(vec![], true),
            namespace(vec![read()], false),
        ]);
        assert_eq!(granted.answer(&pods, "list"), RulesAnswer::Granted);

        let refused = ScopeRules(vec![namespace(vec![read()], true), namespace(vec![], true)]);
        assert_eq!(refused.answer(&pods, "delete"), RulesAnswer::Refused);

        let incomplete = ScopeRules(vec![
            namespace(vec![read()], true),
            namespace(vec![], false),
        ]);
        assert_eq!(incomplete.answer(&pods, "delete"), RulesAnswer::Unknown);

        let failed = ScopeRules(vec![namespace(vec![read()], true), None]);
        assert_eq!(failed.answer(&pods, "delete"), RulesAnswer::Unknown);

        assert_eq!(
            ScopeRules(vec![]).answer(&pods, "list"),
            RulesAnswer::Unknown
        );
    }
}
