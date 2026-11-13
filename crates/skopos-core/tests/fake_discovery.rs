//! Resource discovery and access checks against the fake API server.
//! Every kubeconfig lives in a temp `<home>/.kube`; `KUBECONFIG` is never read.

use std::time::{Duration, Instant};

use skopos_core::app_core::AppCore;
use skopos_core::cluster::ConnectionState;
use skopos_core::error::ErrorCode;
use skopos_core::kubeconfig::ClusterId;
use skopos_core::paths::AppPaths;
use skopos_core::prefs::ClusterSettings;
use skopos_core::resources::ApiResourceInfo;
use skopos_fakekube::{DenyRule, FakeKube, FakeKubeConfig, FakeResource};
use tempfile::TempDir;

const CONTEXT: &str = "fake";
const REVIEWS: &str = "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews";
const RULES: &str = "/apis/authorization.k8s.io/v1/selfsubjectrulesreviews";

async fn core_with_fake(cfg: FakeKubeConfig) -> (AppCore, FakeKube, ClusterId, TempDir) {
    let fake = FakeKube::start(cfg).await.unwrap();
    let root = tempfile::tempdir().unwrap();
    let kube_dir = root.path().join("home").join(".kube");
    std::fs::create_dir_all(&kube_dir).unwrap();
    fake.write_kubeconfig(&kube_dir.join("config"), CONTEXT)
        .unwrap();
    let paths = AppPaths::under(&root.path().join("app"), &root.path().join("home"));
    let core = AppCore::start_with_kubeconfig_env(paths, None)
        .await
        .unwrap();
    let started = Instant::now();
    let id = loop {
        let found = core
            .catalog_list()
            .into_iter()
            .find(|entry| entry.context_name == CONTEXT);
        if let Some(entry) = found {
            break entry.id;
        }
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "timed out waiting for the catalog entry"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    (core, fake, id, root)
}

async fn connected(cfg: FakeKubeConfig) -> (AppCore, FakeKube, ClusterId, TempDir) {
    let (core, fake, id, root) = core_with_fake(cfg).await;
    let state = core.cluster_connect(&id).await.unwrap();
    assert!(
        matches!(state, ConnectionState::Connected { .. }),
        "{state:?}"
    );
    (core, fake, id, root)
}

fn find<'a>(all: &'a [ApiResourceInfo], group: &str, plural: &str) -> &'a ApiResourceInfo {
    all.iter()
        .find(|r| r.resource.group == group && r.resource.plural == plural)
        .unwrap_or_else(|| panic!("{group}/{plural} is not listed"))
}

fn deny(verb: &str, plural: &str, namespace: Option<&str>) -> DenyRule {
    DenyRule {
        verb: verb.into(),
        plural: plural.into(),
        namespace: namespace.map(Into::into),
    }
}

fn widgets() -> FakeResource {
    FakeResource::new("example.com", "v1", "Widget", "widgets", true)
}

#[tokio::test]
async fn lists_preferred_version_of_each_resource_without_subresources() {
    let (core, _fake, id, _root) = connected(FakeKubeConfig::default()).await;

    let all = core.resources_discover(&id, false).await.unwrap();

    let pods = find(&all, "", "pods");
    assert_eq!(pods.resource.version, "v1");
    assert_eq!(pods.resource.kind, "Pod");
    assert!(pods.resource.namespaced);
    assert_eq!(pods.short_names, ["po"]);
    assert!(pods.verbs.iter().any(|v| v == "watch"));
    let deployments = find(&all, "apps", "deployments");
    assert_eq!(deployments.resource.version, "v1");
    assert!(deployments.resource.namespaced);
    assert!(!find(&all, "", "namespaces").resource.namespaced);
    assert!(all.iter().all(|r| !r.resource.plural.contains('/')));
    // It has no `list` verb.
    assert!(all
        .iter()
        .all(|r| r.resource.plural != "selfsubjectaccessreviews"));
}

#[tokio::test]
async fn same_kind_in_two_groups_stays_two_entries() {
    let (core, fake, id, _root) = core_with_fake(FakeKubeConfig::default()).await;
    // The fake keys resources by plural, so the second Event has its own plural.
    fake.serve_resource(FakeResource::new(
        "events.k8s.io",
        "v1",
        "Event",
        "newevents",
        true,
    ));
    core.cluster_connect(&id).await.unwrap();

    let all = core.resources_discover(&id, false).await.unwrap();

    let mut groups: Vec<&str> = all
        .iter()
        .filter(|r| r.resource.kind == "Event")
        .map(|r| r.resource.group.as_str())
        .collect();
    groups.sort_unstable();
    assert_eq!(groups, ["", "events.k8s.io"]);
}

#[tokio::test]
async fn access_flags_follow_rules() {
    let (core, _fake, id, _root) = connected(FakeKubeConfig {
        deny: vec![
            deny("list", "configmaps", None),
            deny("delete", "pods", None),
        ],
        ..Default::default()
    })
    .await;

    let all = core.resources_discover(&id, false).await.unwrap();

    let config_maps = find(&all, "", "configmaps");
    assert!(!config_maps.can_list);
    assert!(config_maps.can_watch);
    let pods = find(&all, "", "pods");
    assert!(pods.can_list);
    assert!(pods.can_watch && pods.can_create && pods.can_update);
    assert!(!pods.can_delete);
}

#[tokio::test]
async fn restricted_user_can_list_if_any_accessible_namespace_allows() {
    let namespaces = vec!["a".to_owned(), "b".to_owned()];
    let (core, _fake, id, _root) = connected(FakeKubeConfig {
        namespaces: namespaces.clone(),
        deny_cluster_wide: vec![deny("list", "pods", None), deny("watch", "pods", None)],
        ..Default::default()
    })
    .await;

    let all = core.resources_discover(&id, false).await.unwrap();

    let pods = find(&all, "", "pods");
    assert!(pods.can_list && pods.can_watch);
    // Nothing is allowed anywhere.
    let (core, _fake, id, _root) = connected(FakeKubeConfig {
        namespaces: vec!["a".to_owned(), "b".to_owned()],
        deny: vec![deny("list", "pods", None)],
        ..Default::default()
    })
    .await;
    let all = core.resources_discover(&id, false).await.unwrap();
    assert!(!find(&all, "", "pods").can_list);
    assert!(find(&all, "", "pods").can_watch);
}

#[tokio::test]
async fn restricted_user_can_patch_if_any_accessible_namespace_allows() {
    // A Role in namespace b only: the actions are offered, and the API server answers
    // for each object.
    let (core, _fake, id, _root) = connected(FakeKubeConfig {
        namespaces: vec!["a".to_owned(), "b".to_owned()],
        deny: vec![
            deny("patch", "pods", Some("a")),
            deny("update", "pods", Some("a")),
            deny("create", "pods", Some("a")),
        ],
        deny_cluster_wide: vec![
            deny("patch", "pods", None),
            deny("update", "pods", None),
            deny("create", "pods", None),
        ],
        ..Default::default()
    })
    .await;
    let all = core.resources_discover(&id, false).await.unwrap();
    let pods = find(&all, "", "pods");
    assert!(pods.can_patch && pods.can_update && pods.can_create);

    // Denied in every namespace, as with a read-only Role.
    let (core, _fake, id, _root) = connected(FakeKubeConfig {
        namespaces: vec!["a".to_owned(), "b".to_owned()],
        deny: vec![
            deny("patch", "pods", Some("a")),
            deny("patch", "pods", Some("b")),
        ],
        deny_cluster_wide: vec![deny("patch", "pods", None)],
        ..Default::default()
    })
    .await;
    let all = core.resources_discover(&id, false).await.unwrap();
    assert!(!find(&all, "", "pods").can_patch);
}

#[tokio::test]
async fn patch_of_a_cluster_scoped_kind_needs_the_cluster_wide_permission() {
    // A review naming a namespace says nothing about a cluster-scoped object.
    let (core, _fake, id, _root) = connected(FakeKubeConfig {
        namespaces: vec!["a".to_owned()],
        deny_cluster_wide: vec![deny("patch", "nodes", None)],
        ..Default::default()
    })
    .await;
    let all = core.resources_discover(&id, false).await.unwrap();
    assert!(!find(&all, "", "nodes").can_patch);
}

#[tokio::test]
async fn delete_is_offered_if_any_accessible_namespace_allows() {
    // A Role in namespace b only: the table offers delete, and the API server
    // answers for each object.
    let (core, _fake, id, _root) = connected(FakeKubeConfig {
        namespaces: vec!["a".to_owned(), "b".to_owned()],
        deny: vec![deny("delete", "pods", Some("a"))],
        deny_cluster_wide: vec![deny("delete", "pods", None)],
        ..Default::default()
    })
    .await;
    let all = core.resources_discover(&id, false).await.unwrap();
    assert!(find(&all, "", "pods").can_delete);

    // Denied in every namespace, as with a read-only Role.
    let (core, _fake, id, _root) = connected(FakeKubeConfig {
        namespaces: vec!["a".to_owned(), "b".to_owned()],
        deny: vec![
            deny("delete", "pods", Some("a")),
            deny("delete", "pods", Some("b")),
        ],
        deny_cluster_wide: vec![deny("delete", "pods", None)],
        ..Default::default()
    })
    .await;
    let all = core.resources_discover(&id, false).await.unwrap();
    assert!(!find(&all, "", "pods").can_delete);
}

#[tokio::test]
async fn delete_of_a_cluster_scoped_kind_needs_the_cluster_wide_permission() {
    // A review naming a namespace says nothing about a cluster-scoped object, so a
    // user limited to namespaces must not be offered this delete.
    let (core, fake, id, _root) = core_with_fake(FakeKubeConfig {
        forbid_namespace_list: true,
        deny_cluster_wide: vec![deny("delete", "gadgets", None)],
        ..Default::default()
    })
    .await;
    core.cluster_settings_set(
        &id,
        ClusterSettings {
            accessible_namespaces: vec!["a".into()],
            ..Default::default()
        },
    )
    .unwrap();
    let state = core.cluster_connect(&id).await.unwrap();
    assert!(
        matches!(state, ConnectionState::Connected { .. }),
        "{state:?}"
    );
    fake.serve_resource(FakeResource::new(
        "example.com",
        "v1",
        "Gadget",
        "gadgets",
        false,
    ));

    let all = core.resources_discover(&id, true).await.unwrap();

    assert!(!find(&all, "example.com", "gadgets").can_delete);
}

fn reviews_of(fake: &FakeKube, verb: &str, plural: &str) -> usize {
    fake.access_reviews()
        .iter()
        .filter(|r| r.verb == verb && r.resource == plural)
        .count()
}

#[tokio::test]
async fn a_user_with_every_permission_needs_one_access_review() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    let before = fake.request_count(REVIEWS);

    let all = core.resources_discover(&id, false).await.unwrap();

    assert_eq!(fake.request_count(REVIEWS) - before, 1);
    assert_eq!(fake.request_count(RULES), 0);
    for r in &all {
        assert!(
            r.can_list
                && r.can_watch
                && r.can_create
                && r.can_update
                && r.can_patch
                && r.can_delete,
            "{} should be fully allowed",
            r.resource.plural
        );
    }
}

#[tokio::test]
async fn namespaced_access_comes_from_one_rules_review_per_namespace() {
    let (core, fake, id, _root) = connected(FakeKubeConfig {
        namespaces: vec!["a".to_owned(), "b".to_owned()],
        deny: vec![
            deny("delete", "pods", Some("a")),
            deny("list", "configmaps", None),
        ],
        deny_cluster_wide: vec![deny("delete", "pods", None)],
        ..Default::default()
    })
    .await;

    let all = core.resources_discover(&id, false).await.unwrap();

    assert_eq!(fake.request_count(RULES), 2);
    let pods = find(&all, "", "pods");
    assert!(pods.can_list && pods.can_delete, "namespace b allows both");
    assert!(!find(&all, "", "configmaps").can_list);
    for plural in ["pods", "configmaps"] {
        for verb in ["list", "watch", "create", "update", "patch", "delete"] {
            assert_eq!(reviews_of(&fake, verb, plural), 0, "{verb} {plural}");
        }
    }
}

#[tokio::test]
async fn a_cluster_scoped_kind_no_rule_grants_needs_no_access_review() {
    let (core, fake, id, _root) = connected(FakeKubeConfig {
        namespaces: vec!["a".to_owned()],
        deny: vec![deny("delete", "nodes", None)],
        ..Default::default()
    })
    .await;

    let all = core.resources_discover(&id, false).await.unwrap();

    let nodes = find(&all, "", "nodes");
    assert!(nodes.can_list && !nodes.can_delete);
    assert_eq!(reviews_of(&fake, "delete", "nodes"), 0);
    // A rule that names a cluster-scoped kind may come from a RoleBinding, so the
    // cluster-wide answer still comes from an access review.
    assert!(reviews_of(&fake, "list", "nodes") > 0);
}

#[tokio::test]
async fn incomplete_rules_fall_back_to_access_reviews() {
    let (core, fake, id, _root) = connected(FakeKubeConfig {
        namespaces: vec!["a".to_owned()],
        incomplete_rules_reviews: true,
        deny: vec![deny("delete", "pods", None)],
        ..Default::default()
    })
    .await;

    let all = core.resources_discover(&id, false).await.unwrap();

    let pods = find(&all, "", "pods");
    assert!(pods.can_list && !pods.can_delete);
    assert!(reviews_of(&fake, "delete", "pods") > 0);
}

#[tokio::test]
async fn access_check_failure_fails_open() {
    let (core, _fake, id, _root) = connected(FakeKubeConfig {
        fail_access_reviews: true,
        ..Default::default()
    })
    .await;

    let all = core.resources_discover(&id, false).await.unwrap();

    assert!(!all.is_empty());
    for r in &all {
        assert!(
            r.can_list && r.can_watch && r.can_create && r.can_update && r.can_delete,
            "{} should stay available",
            r.resource.plural
        );
    }
}

#[tokio::test]
async fn results_are_cached_until_refresh() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    let first = core.resources_discover(&id, false).await.unwrap();
    let reviews = fake.request_count(REVIEWS);
    fake.serve_resource(widgets());

    let second = core.resources_discover(&id, false).await.unwrap();

    assert_eq!(second, first);
    assert_eq!(fake.request_count(REVIEWS), reviews);
    assert!(second.iter().all(|r| r.resource.plural != "widgets"));

    let refreshed = core.resources_discover(&id, true).await.unwrap();

    assert!(fake.request_count(REVIEWS) > reviews);
    assert!(find(&refreshed, "example.com", "widgets").can_list);
    assert!(core
        .cluster_discovery(&id)
        .unwrap()
        .groups()
        .any(|g| g.name() == "example.com"));
    // The refreshed answer is the cached one.
    let reviews = fake.request_count(REVIEWS);
    assert_eq!(
        core.resources_discover(&id, false).await.unwrap(),
        refreshed
    );
    assert_eq!(fake.request_count(REVIEWS), reviews);
}

#[tokio::test]
async fn disconnected_cluster_is_an_error() {
    let (core, _fake, id, _root) = core_with_fake(FakeKubeConfig::default()).await;

    let err = core.resources_discover(&id, false).await.unwrap_err();

    assert_eq!(err.code, ErrorCode::InvalidInput);
    assert!(err.message.contains("disconnected"), "{}", err.message);
}

#[tokio::test]
async fn reconnect_clears_the_cache() {
    let (core, fake, id, _root) = connected(FakeKubeConfig::default()).await;
    core.resources_discover(&id, false).await.unwrap();
    fake.serve_resource(widgets());

    core.cluster_disconnect(&id).await.unwrap();
    core.cluster_connect(&id).await.unwrap();
    let all = core.resources_discover(&id, false).await.unwrap();

    assert!(find(&all, "example.com", "widgets").can_list);
}
