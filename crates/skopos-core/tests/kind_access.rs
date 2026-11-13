//! Access checks against the real `skopos-e2e` kind cluster: an admin, and a user who may
//! only read ConfigMaps in one namespace, which the rules review answers. Run with
//! `make test-kind`.

mod support;

use skopos_core::prefs::ClusterSettings;
use skopos_core::resources::ApiResourceInfo;
use support::{connected_kind, connected_with, in_namespace, kubeconfig_with_token, viewer_token};

const NAMESPACE: &str = "skopos-access";

fn find<'a>(all: &'a [ApiResourceInfo], group: &str, plural: &str) -> &'a ApiResourceInfo {
    all.iter()
        .find(|r| r.resource.group == group && r.resource.plural == plural)
        .unwrap_or_else(|| panic!("{group}/{plural} is not listed"))
}

#[tokio::test]
#[ignore = "needs make test-kind"]
async fn an_admin_may_use_every_verb() {
    let (core, id, _root) = connected_kind().await;

    let all = core.resources_discover(&id, true).await.unwrap();

    for (group, plural) in [("", "pods"), ("", "nodes"), ("apps", "deployments")] {
        let r = find(&all, group, plural);
        assert!(
            r.can_list
                && r.can_watch
                && r.can_create
                && r.can_update
                && r.can_patch
                && r.can_delete,
            "{plural}: {r:?}"
        );
    }
    core.shutdown().await;
}

#[tokio::test]
#[ignore = "needs make test-kind"]
async fn a_namespace_viewer_gets_what_its_role_grants() {
    let (admin, admin_id, _admin_root) = connected_kind().await;
    let client = admin.cluster_client(&admin_id).unwrap();
    in_namespace(&client, NAMESPACE, async {
        let token = viewer_token(&client, NAMESPACE).await;
        let (core, id, _root) = connected_with(&kubeconfig_with_token(&token), "viewer").await;
        // The viewer cannot list namespaces, so it names the one it may use.
        core.cluster_settings_set(
            &id,
            ClusterSettings {
                accessible_namespaces: vec![NAMESPACE.into()],
                ..Default::default()
            },
        )
        .unwrap();
        core.cluster_disconnect(&id).await.unwrap();
        core.cluster_connect(&id).await.unwrap();

        let all = core.resources_discover(&id, false).await.unwrap();

        let config_maps = find(&all, "", "configmaps");
        assert!(
            config_maps.can_list && config_maps.can_watch,
            "{config_maps:?}"
        );
        assert!(
            !(config_maps.can_create
                || config_maps.can_update
                || config_maps.can_patch
                || config_maps.can_delete),
            "{config_maps:?}"
        );
        for (group, plural) in [("", "pods"), ("", "nodes"), ("apps", "deployments")] {
            let r = find(&all, group, plural);
            assert!(
                !(r.can_list || r.can_watch || r.can_delete),
                "{plural}: {r:?}"
            );
        }
        core.shutdown().await;
    })
    .await;
    admin.shutdown().await;
}
