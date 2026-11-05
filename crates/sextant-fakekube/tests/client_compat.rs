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
