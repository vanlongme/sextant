//! What the integration tests share: a core connected to the fake or to the kind cluster.
//! Every kubeconfig lives in a temp `<home>/.kube`; `KUBECONFIG` is never read.
//! Each test binary uses part of this.
#![allow(dead_code)]

use std::path::Path;
use std::time::{Duration, Instant};

use sextant_core::app_core::AppCore;
use sextant_core::cluster::ConnectionState;
use sextant_core::kubeconfig::ClusterId;
use sextant_core::paths::AppPaths;
use sextant_fakekube::{FakeKube, FakeKubeConfig};
use tempfile::TempDir;

const FAKE_CONTEXT: &str = "fake";
const KIND_CONTEXT: &str = "kind-sextant-e2e";
const CATALOG_WAIT: Duration = Duration::from_secs(30);

async fn start_core(root: &Path, context: &str) -> (AppCore, ClusterId) {
    let paths = AppPaths::under(&root.join("app"), &root.join("home"));
    let core = AppCore::start_with_kubeconfig_env(paths, None)
        .await
        .unwrap();
    let started = Instant::now();
    let id = loop {
        let found = core
            .catalog_list()
            .into_iter()
            .find(|entry| entry.context_name == context);
        if let Some(entry) = found {
            break entry.id;
        }
        assert!(started.elapsed() < CATALOG_WAIT, "no catalog entry");
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    let state = core.cluster_connect(&id).await.unwrap();
    assert!(
        matches!(state, ConnectionState::Connected { .. }),
        "{state:?}"
    );
    (core, id)
}

pub async fn connected_fake(cfg: FakeKubeConfig) -> (AppCore, FakeKube, ClusterId, TempDir) {
    let fake = FakeKube::start(cfg).await.unwrap();
    let root = tempfile::tempdir().unwrap();
    let kube_dir = root.path().join("home").join(".kube");
    std::fs::create_dir_all(&kube_dir).unwrap();
    fake.write_kubeconfig(&kube_dir.join("config"), FAKE_CONTEXT)
        .unwrap();
    let (core, id) = start_core(root.path(), FAKE_CONTEXT).await;
    (core, fake, id, root)
}

/// Needs `make test-kind`. Only `e2e/.tmp/kubeconfig` is read, never a default one.
pub async fn connected_kind() -> (AppCore, ClusterId, TempDir) {
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../e2e/.tmp/kubeconfig");
    let root = tempfile::tempdir().unwrap();
    let kube_dir = root.path().join("home").join(".kube");
    std::fs::create_dir_all(&kube_dir).unwrap();
    std::fs::copy(source, kube_dir.join("config")).unwrap();
    let (core, id) = start_core(root.path(), KIND_CONTEXT).await;
    (core, id, root)
}
