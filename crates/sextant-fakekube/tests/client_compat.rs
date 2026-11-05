use futures::StreamExt;
use k8s_openapi::api::core::v1::{Namespace, Pod};
use kube::runtime::{watcher, WatchStreamExt};
use kube::{
    api::ListParams,
    config::{KubeConfigOptions, Kubeconfig},
    discovery::Discovery,
    Api, Client, Config,
};
use sextant_fakekube::{FakeKube, FakeKubeConfig};

async fn client_for(fake: &FakeKube, dir: &std::path::Path) -> Client {
    let path = dir.join("config");
    fake.write_kubeconfig(&path, "fake").unwrap();
    let kc = Kubeconfig::read_from(&path).unwrap();
    let opts = KubeConfigOptions {
        context: Some("fake".into()),
        ..Default::default()
    };
    let cfg = Config::from_custom_kubeconfig(kc, &opts).await.unwrap();
    Client::try_from(cfg).unwrap()
}

#[tokio::test]
async fn real_kube_client_can_use_the_fake() {
    let dir = tempfile::tempdir().unwrap();
    let fake = FakeKube::start(FakeKubeConfig::default()).await.unwrap();
    let client = client_for(&fake, dir.path()).await;

    let info = client.apiserver_version().await.unwrap();
    assert_eq!(info.git_version, "v1.37.0");

    let discovery = Discovery::new(client.clone())
        .run_aggregated()
        .await
        .unwrap();
    assert!(discovery.groups().any(|g| g.name() == ""));

    let ns: Api<Namespace> = Api::all(client.clone());
    assert_eq!(
        ns.list(&ListParams::default()).await.unwrap().items.len(),
        2
    );

    fake.add_pod("default", "first");
    let pods: Api<Pod> = Api::all(client.clone());
    assert_eq!(
        pods.list(&ListParams::default()).await.unwrap().items.len(),
        1
    );
}

#[tokio::test]
async fn watch_streams_added_and_deleted() {
    let dir = tempfile::tempdir().unwrap();
    let fake = FakeKube::start(FakeKubeConfig::default()).await.unwrap();
    let client = client_for(&fake, dir.path()).await;
    let pods: Api<Pod> = Api::all(client);
    let mut stream = watcher(pods, Default::default()).applied_objects().boxed();
    fake.add_pod("default", "watched");
    let got = tokio::time::timeout(std::time::Duration::from_secs(10), stream.next())
        .await
        .unwrap();
    assert_eq!(
        got.unwrap().unwrap().metadata.name.as_deref(),
        Some("watched")
    );
}

#[tokio::test]
async fn unauthorized_mode_returns_401() {
    let dir = tempfile::tempdir().unwrap();
    let fake = FakeKube::start(FakeKubeConfig {
        unauthorized: true,
        ..Default::default()
    })
    .await
    .unwrap();
    let client = client_for(&fake, dir.path()).await;
    let err = client.apiserver_version().await.unwrap_err();
    assert!(format!("{err:?}").contains("401"));
}

mod generic {
    use super::client_for;
    use futures::StreamExt;
    use k8s_openapi::api::authorization::v1::{
        ResourceAttributes, SelfSubjectAccessReview, SelfSubjectAccessReviewSpec,
    };
    use k8s_openapi::api::core::v1::{ConfigMap, Pod};
    use kube::api::{DeleteParams, ListParams, Patch, PatchParams, PostParams};
    use kube::core::{ApiResource, DynamicObject, GroupVersionKind};
    use kube::discovery::Discovery;
    use kube::runtime::{watcher, WatchStreamExt};
    use kube::{Api, Client};
    use serde_json::json;
    use sextant_fakekube::{DenyRule, FakeKube, FakeKubeConfig, FakeResource};

    fn cm_api(client: Client, ns: &str) -> Api<DynamicObject> {
        let ar = ApiResource::erase::<ConfigMap>(&());
        Api::namespaced_with(client, ns, &ar)
    }

    fn cm(name: &str, value: &str) -> DynamicObject {
        let ar = ApiResource::erase::<ConfigMap>(&());
        DynamicObject::new(name, &ar)
            .within("default")
            .data(json!({ "data": { "a": value } }))
    }

    fn api_code(err: kube::Error) -> u16 {
        match err {
            kube::Error::Api(s) => s.code,
            other => panic!("expected an API error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn generic_crud_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let fake = FakeKube::start(FakeKubeConfig::default()).await.unwrap();
        let api = cm_api(client_for(&fake, dir.path()).await, "default");
        let lp = ListParams::default();
        assert!(api.list(&lp).await.unwrap().items.is_empty());

        let created = api
            .create(&PostParams::default(), &cm("one", "1"))
            .await
            .unwrap();
        assert!(created.metadata.uid.is_some());
        let rv1 = created.metadata.resource_version.clone().unwrap();
        assert_eq!(api.list(&lp).await.unwrap().items.len(), 1);

        let got = api.get("one").await.unwrap();
        assert_eq!(got.data["data"]["a"], "1");

        let mut changed = got.clone();
        changed.data["data"]["a"] = json!("2");
        let put = api
            .replace("one", &PostParams::default(), &changed)
            .await
            .unwrap();
        assert_ne!(put.metadata.resource_version.as_ref().unwrap(), &rv1);
        assert_eq!(put.metadata.uid, created.metadata.uid);
        let listed = api.list(&lp).await.unwrap();
        assert_eq!(listed.items[0].data["data"]["a"], "2");

        api.delete("one", &DeleteParams::default()).await.unwrap();
        assert!(api.list(&lp).await.unwrap().items.is_empty());
        assert_eq!(api_code(api.get("one").await.unwrap_err()), 404);
    }

    #[tokio::test]
    async fn put_with_stale_resource_version_is_409() {
        let dir = tempfile::tempdir().unwrap();
        let fake = FakeKube::start(FakeKubeConfig::default()).await.unwrap();
        let api = cm_api(client_for(&fake, dir.path()).await, "default");
        let first = api
            .create(&PostParams::default(), &cm("one", "1"))
            .await
            .unwrap();
        let mut newer = first.clone();
        newer.data["data"]["a"] = json!("2");
        api.replace("one", &PostParams::default(), &newer)
            .await
            .unwrap();

        let mut stale = first.clone();
        stale.data["data"]["a"] = json!("3");
        let err = api
            .replace("one", &PostParams::default(), &stale)
            .await
            .unwrap_err();
        match err {
            kube::Error::Api(s) => {
                assert_eq!(s.code, 409);
                assert_eq!(s.reason, "Conflict");
            }
            other => panic!("expected an API error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn server_side_apply_upserts() {
        let dir = tempfile::tempdir().unwrap();
        let fake = FakeKube::start(FakeKubeConfig::default()).await.unwrap();
        let api = cm_api(client_for(&fake, dir.path()).await, "default");
        let pp = PatchParams::apply("sextant-test");
        let first = api
            .patch(
                "applied",
                &pp,
                &Patch::Apply(json!({
                    "apiVersion": "v1", "kind": "ConfigMap",
                    "metadata": { "name": "applied" }, "data": { "a": "1" }
                })),
            )
            .await
            .unwrap();
        let rv1 = first.metadata.resource_version.clone().unwrap();
        let second = api
            .patch(
                "applied",
                &pp,
                &Patch::Apply(json!({
                    "apiVersion": "v1", "kind": "ConfigMap",
                    "metadata": { "name": "applied" }, "data": { "b": "2" }
                })),
            )
            .await
            .unwrap();
        let rv2 = second.metadata.resource_version.clone().unwrap();
        assert_ne!(rv1, rv2);
        assert_eq!(second.metadata.uid, first.metadata.uid);
        assert_eq!(second.data["data"]["a"], "1");
        assert_eq!(second.data["data"]["b"], "2");
        assert_eq!(
            api.list(&ListParams::default()).await.unwrap().items.len(),
            1
        );
    }

    #[tokio::test]
    async fn custom_resource_is_discoverable_and_removable() {
        let dir = tempfile::tempdir().unwrap();
        let fake = FakeKube::start(FakeKubeConfig::default()).await.unwrap();
        let client = client_for(&fake, dir.path()).await;
        fake.serve_resource(FakeResource {
            group: "example.com".into(),
            version: "v1".into(),
            kind: "Widget".into(),
            plural: "widgets".into(),
            namespaced: true,
        });

        let discovery = Discovery::new(client.clone())
            .run_aggregated()
            .await
            .unwrap();
        let gvk = GroupVersionKind::gvk("example.com", "v1", "Widget");
        let (ar, _caps) = discovery
            .resolve_gvk(&gvk)
            .expect("widgets is discoverable");
        assert_eq!(ar.plural, "widgets");

        fake.upsert(
            "widgets",
            json!({ "metadata": { "name": "w1", "namespace": "default" }, "spec": { "size": 3 } }),
        );
        let api: Api<DynamicObject> = Api::all_with(client.clone(), &ar);
        let items = api.list(&ListParams::default()).await.unwrap().items;
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].data["spec"]["size"], 3);

        fake.remove_resource("widgets");
        let discovery = Discovery::new(client.clone())
            .run_aggregated()
            .await
            .unwrap();
        assert!(discovery.resolve_gvk(&gvk).is_none());
        assert!(!discovery.groups().any(|g| g.name() == "example.com"));
        assert_eq!(
            api_code(api.list(&ListParams::default()).await.unwrap_err()),
            404
        );
    }

    #[tokio::test]
    async fn deny_rule_drives_ssar_and_real_403() {
        let dir = tempfile::tempdir().unwrap();
        let fake = FakeKube::start(FakeKubeConfig {
            deny: vec![DenyRule {
                verb: "list".into(),
                plural: "configmaps".into(),
                namespace: None,
            }],
            ..Default::default()
        })
        .await
        .unwrap();
        let client = client_for(&fake, dir.path()).await;

        let reviews: Api<SelfSubjectAccessReview> = Api::all(client.clone());
        let allowed = |verb: &str, resource: &str| {
            let reviews = reviews.clone();
            let review = SelfSubjectAccessReview {
                spec: SelfSubjectAccessReviewSpec {
                    resource_attributes: Some(ResourceAttributes {
                        verb: Some(verb.into()),
                        resource: Some(resource.into()),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                ..Default::default()
            };
            async move {
                reviews
                    .create(&PostParams::default(), &review)
                    .await
                    .unwrap()
                    .status
                    .unwrap()
                    .allowed
            }
        };
        assert!(!allowed("list", "configmaps").await);
        assert!(allowed("get", "configmaps").await);
        assert!(allowed("list", "pods").await);

        let cms: Api<ConfigMap> = Api::all(client.clone());
        assert_eq!(
            api_code(cms.list(&ListParams::default()).await.unwrap_err()),
            403
        );
        let pods: Api<Pod> = Api::all(client);
        assert!(pods.list(&ListParams::default()).await.is_ok());
    }

    async fn next<S>(stream: &mut S) -> serde_json::Value
    where
        S: futures::Stream<Item = Result<ConfigMap, watcher::Error>> + Unpin,
    {
        let cm = tokio::time::timeout(std::time::Duration::from_secs(10), stream.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        json!(cm.data.unwrap()["a"])
    }

    #[tokio::test]
    async fn watch_gets_modified_events() {
        let dir = tempfile::tempdir().unwrap();
        let fake = FakeKube::start(FakeKubeConfig::default()).await.unwrap();
        let client = client_for(&fake, dir.path()).await;
        let object = |value: &str| json!({ "metadata": { "name": "w", "namespace": "default" }, "data": { "a": value } });
        fake.upsert("configmaps", object("1"));
        let api: Api<ConfigMap> = Api::all(client);
        let mut stream = watcher(api, Default::default()).applied_objects().boxed();
        assert_eq!(next(&mut stream).await, "1");
        fake.upsert("configmaps", object("2"));
        assert_eq!(next(&mut stream).await, "2");
        fake.upsert("configmaps", object("3"));
        assert_eq!(next(&mut stream).await, "3");
    }

    #[tokio::test]
    async fn fail_watches_with_status_until_cleared() {
        let dir = tempfile::tempdir().unwrap();
        let fake = FakeKube::start(FakeKubeConfig::default()).await.unwrap();
        let api = cm_api(client_for(&fake, dir.path()).await, "default");
        fake.fail_watches_with("configmaps", Some(410));
        assert_eq!(
            api_code(api.list(&ListParams::default()).await.unwrap_err()),
            410
        );
        fake.fail_watches_with("configmaps", None);
        assert!(api.list(&ListParams::default()).await.is_ok());
    }
}
