//! The connection lifecycle against the real `sextant-e2e` kind cluster.
//! Needs `make test-kind`. Only `e2e/.tmp/kubeconfig` is read, never a default one.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use base64::Engine;
use serde_yaml_ng::Value;
use sextant_core::app_core::AppCore;
use sextant_core::cluster::ConnectionState;
use sextant_core::kubeconfig::ClusterId;
use sextant_core::paths::AppPaths;
use tempfile::TempDir;

const CONTEXT: &str = "kind-sextant-e2e";
const SECOND_CONTEXT: &str = "second";
const PICKUP_LIMIT: Duration = Duration::from_secs(2);
const REMOVAL_LIMIT: Duration = Duration::from_secs(3);

fn e2e_kubeconfig() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../e2e/.tmp/kubeconfig")
}

fn e2e_document() -> Value {
    serde_yaml_ng::from_slice(&std::fs::read(e2e_kubeconfig()).unwrap()).unwrap()
}

/// `document` with one more context for the same cluster and user.
fn with_second_context(mut document: Value) -> Value {
    let contexts = document["contexts"].as_sequence_mut().unwrap();
    let mut second = contexts[0].clone();
    second["name"] = Value::String(SECOND_CONTEXT.to_owned());
    contexts.push(second);
    document
}

fn write_document(path: &Path, document: &Value) {
    std::fs::write(path, serde_yaml_ng::to_string(document).unwrap()).unwrap();
}

struct Fixture {
    root: TempDir,
    core: AppCore,
}

impl Fixture {
    fn kube_dir(root: &TempDir) -> PathBuf {
        root.path().join("home").join(".kube")
    }

    fn config(&self) -> PathBuf {
        Self::kube_dir(&self.root).join("config")
    }

    /// Starts a core whose `<home>/.kube/config` is what `prepare` writes.
    async fn start(prepare: impl FnOnce(&Path)) -> Fixture {
        let root = tempfile::tempdir().unwrap();
        let kube_dir = Self::kube_dir(&root);
        std::fs::create_dir_all(&kube_dir).unwrap();
        prepare(&kube_dir);
        let paths = AppPaths::under(&root.path().join("app"), &root.path().join("home"));
        let core = AppCore::start_with_kubeconfig_env(paths, None)
            .await
            .unwrap();
        Fixture { root, core }
    }

    async fn with_e2e_config() -> Fixture {
        Self::start(|kube_dir| {
            std::fs::copy(e2e_kubeconfig(), kube_dir.join("config")).unwrap();
        })
        .await
    }

    fn entry_id(&self, context: &str) -> Option<ClusterId> {
        let entries = self.core.catalog_list();
        let entry = entries.iter().find(|entry| entry.context_name == context)?;
        Some(entry.id.clone())
    }

    async fn wait_for_entry(&self, context: &str, limit: Duration) -> ClusterId {
        let started = Instant::now();
        loop {
            if let Some(id) = self.entry_id(context) {
                return id;
            }
            assert!(
                started.elapsed() < limit,
                "no catalog entry {context} within {limit:?}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    async fn connect(&self, id: &ClusterId) -> ConnectionState {
        let state = self.core.cluster_connect(id).await.unwrap();
        assert!(
            matches!(state, ConnectionState::Connected { .. }),
            "{state:?}\n{:?}",
            self.core.cluster_log(id)
        );
        state
    }
}

#[tokio::test]
#[ignore = "needs make test-kind"]
async fn connects_to_real_cluster() {
    let fixture = Fixture::with_e2e_config().await;
    let id = fixture.wait_for_entry(CONTEXT, REMOVAL_LIMIT).await;

    let state = fixture.connect(&id).await;

    let ConnectionState::Connected { info } = state else {
        unreachable!();
    };
    assert_eq!(info.distribution, "kind");
    assert!(info.node_count.is_some_and(|n| n >= 1), "{info:?}");
    assert!(info.namespaces.iter().any(|n| n == "kube-system"));
    assert!(!info.namespaces_restricted);
    assert!(info.is_admin);
    let discovery = fixture.core.cluster_discovery(&id).unwrap();
    assert!(discovery.has_group("apps"));

    fixture.core.cluster_disconnect(&id).await.unwrap();

    assert_eq!(
        fixture.core.cluster_state(&id),
        ConnectionState::Disconnected
    );
}

#[tokio::test]
#[ignore = "needs make test-kind"]
async fn disconnect_deletes_the_per_context_kubeconfig() {
    let fixture = Fixture::with_e2e_config().await;
    let id = fixture.wait_for_entry(CONTEXT, REMOVAL_LIMIT).await;
    fixture.connect(&id).await;
    let path = fixture.core.cluster_kubeconfig_path(&id).unwrap();
    assert!(path.exists());

    fixture.core.cluster_disconnect(&id).await.unwrap();

    assert!(!path.exists());
}

#[tokio::test]
#[ignore = "needs make test-kind"]
async fn file_change_is_picked_up_within_two_seconds() {
    let fixture = Fixture::with_e2e_config().await;
    fixture.wait_for_entry(CONTEXT, REMOVAL_LIMIT).await;

    write_document(&fixture.config(), &with_second_context(e2e_document()));

    let id = fixture.wait_for_entry(SECOND_CONTEXT, PICKUP_LIMIT).await;
    fixture.connect(&id).await;
}

#[tokio::test]
#[ignore = "needs make test-kind"]
async fn removing_a_context_disconnects_and_removes_it() {
    let fixture = Fixture::start(|kube_dir| {
        write_document(
            &kube_dir.join("config"),
            &with_second_context(e2e_document()),
        );
    })
    .await;
    let kept = fixture.wait_for_entry(CONTEXT, REMOVAL_LIMIT).await;
    let removed = fixture.wait_for_entry(SECOND_CONTEXT, REMOVAL_LIMIT).await;
    fixture.connect(&kept).await;
    fixture.connect(&removed).await;
    let path = fixture.core.cluster_kubeconfig_path(&removed).unwrap();

    write_document(&fixture.config(), &e2e_document());

    let started = Instant::now();
    while fixture.entry_id(SECOND_CONTEXT).is_some()
        || fixture.core.cluster_state(&removed) != ConnectionState::Disconnected
    {
        assert!(
            started.elapsed() < REMOVAL_LIMIT,
            "the context is still here"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(!path.exists());
    assert!(matches!(
        fixture.core.cluster_state(&kept),
        ConnectionState::Connected { .. }
    ));
}

/// Moves inline `<key>-data` to a file beside the kubeconfig, referred to relatively.
fn move_to_relative_file(body: &mut Value, key: &str, kube_dir: &Path, file: &str) {
    let data_key = format!("{key}-data");
    let encoded = body[data_key.as_str()].as_str().unwrap().to_owned();
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .unwrap();
    std::fs::write(kube_dir.join("certs").join(file), decoded).unwrap();
    let map = body.as_mapping_mut().unwrap();
    map.remove(data_key.as_str());
    map.insert(
        Value::String(key.to_owned()),
        Value::String(format!("certs/{file}")),
    );
}

#[tokio::test]
#[ignore = "needs make test-kind"]
async fn relative_certificate_paths_connect() {
    let fixture = Fixture::start(|kube_dir| {
        std::fs::create_dir_all(kube_dir.join("certs")).unwrap();
        let mut document = e2e_document();
        let cluster = &mut document["clusters"][0]["cluster"];
        move_to_relative_file(cluster, "certificate-authority", kube_dir, "ca.crt");
        let user = &mut document["users"][0]["user"];
        move_to_relative_file(user, "client-certificate", kube_dir, "client.crt");
        move_to_relative_file(user, "client-key", kube_dir, "client.key");
        write_document(&kube_dir.join("config"), &document);
    })
    .await;
    let id = fixture.wait_for_entry(CONTEXT, REMOVAL_LIMIT).await;

    let state = fixture.connect(&id).await;

    let ConnectionState::Connected { info } = state else {
        unreachable!();
    };
    assert!(info.namespaces.iter().any(|n| n == "kube-system"));
}
