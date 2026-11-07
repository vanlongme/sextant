//! The object actions of section 5.6 against the real `sextant-e2e` kind cluster.
//! Needs `make test-kind`. Only `e2e/.tmp/kubeconfig` is read, never a default one.

mod support;

use std::collections::BTreeMap;
use std::panic::AssertUnwindSafe;
use std::time::{Duration, Instant};

use futures::FutureExt;
use k8s_openapi::api::batch::v1::Job;
use k8s_openapi::api::core::v1::{ConfigMap, Pod, ServiceAccount};
use k8s_openapi::api::networking::v1::IngressClass;
use kube::api::{DeleteParams, ObjectMeta, Patch, PatchParams, PostParams};
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{Api, Client, Config};
use serde_json::json;
use sextant_core::error::ErrorCode;
use sextant_core::resources::ResourceRef;
use support::{connected_kind, create_pod, in_namespace, wait_running, TEST_IMAGE};

const WAIT: Duration = Duration::from_secs(60);
const DEFAULT_CLASS: &str = "ingressclass.kubernetes.io/is-default-class";

#[tokio::test]
#[ignore = "needs the sextant-e2e kind cluster"]
async fn force_delete_does_not_wait_out_the_grace_period() {
    const NAMESPACE: &str = "sextant-test-actions-delete";
    let (core, id, _root) = connected_kind().await;
    let client = core.cluster_client(&id).unwrap();
    in_namespace(&client, NAMESPACE, async {
        let pod = json!({
            "metadata": { "name": "slow" },
            "spec": {
                "terminationGracePeriodSeconds": 600,
                "containers": [{ "name": "main", "image": TEST_IMAGE, "args": ["pause"] }],
            },
        });
        let stale = create_pod(&client, NAMESPACE, pod)
            .await
            .metadata
            .uid
            .unwrap();
        wait_running(&client, NAMESPACE, "slow").await;
        core.pod_force_delete(&id, NAMESPACE, "slow", &stale)
            .await
            .unwrap();
        let pods: Api<Pod> = Api::namespaced(client.clone(), NAMESPACE);
        let started = Instant::now();
        while pods.get_opt("slow").await.unwrap().is_some() {
            assert!(started.elapsed() < WAIT, "the pod is still there");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        // A replacement under the same name, as a StatefulSet makes, outlives a stale row.
        let replacement = json!({
            "metadata": { "name": "slow" },
            "spec": {
                "terminationGracePeriodSeconds": 0,
                "containers": [{ "name": "main", "image": TEST_IMAGE, "args": ["pause"] }],
            },
        });
        let fresh = create_pod(&client, NAMESPACE, replacement)
            .await
            .metadata
            .uid
            .unwrap();
        let error = core
            .pod_force_delete(&id, NAMESPACE, "slow", &stale)
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::Conflict, "{}", error.message);
        let kept = pods.get("slow").await.unwrap();
        assert_eq!(kept.metadata.uid.as_deref(), Some(fresh.as_str()));
        assert!(kept.metadata.deletion_timestamp.is_none());
    })
    .await;
}

#[tokio::test]
#[ignore = "needs the sextant-e2e kind cluster"]
async fn force_finalize_lets_a_stuck_object_go_and_is_refused_before_deletion() {
    const NAMESPACE: &str = "sextant-test-actions-finalize";
    let (core, id, _root) = connected_kind().await;
    let client = core.cluster_client(&id).unwrap();
    in_namespace(&client, NAMESPACE, async {
        let config_maps: Api<ConfigMap> = Api::namespaced(client.clone(), NAMESPACE);
        let stuck = ConfigMap {
            metadata: ObjectMeta {
                name: Some("stuck".into()),
                finalizers: Some(vec!["sextant.dev/test".into()]),
                ..ObjectMeta::default()
            },
            ..ConfigMap::default()
        };
        config_maps
            .create(&PostParams::default(), &stuck)
            .await
            .unwrap();
        let resource = ResourceRef {
            group: String::new(),
            version: "v1".into(),
            plural: "configmaps".into(),
            kind: "ConfigMap".into(),
            namespaced: true,
        };
        let error = core
            .resource_force_finalize(&id, &resource, Some(NAMESPACE), "stuck")
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput);

        config_maps
            .delete("stuck", &DeleteParams::default())
            .await
            .unwrap();
        assert!(config_maps
            .get("stuck")
            .await
            .unwrap()
            .metadata
            .deletion_timestamp
            .is_some());
        core.resource_force_finalize(&id, &resource, Some(NAMESPACE), "stuck")
            .await
            .unwrap();
        assert!(config_maps.get_opt("stuck").await.unwrap().is_none());
    })
    .await;
}

#[tokio::test]
#[ignore = "needs the sextant-e2e kind cluster"]
async fn a_job_suspends_and_resumes() {
    const NAMESPACE: &str = "sextant-test-actions-job";
    let (core, id, _root) = connected_kind().await;
    let client = core.cluster_client(&id).unwrap();
    in_namespace(&client, NAMESPACE, async {
        let jobs: Api<Job> = Api::namespaced(client.clone(), NAMESPACE);
        let job: Job = serde_json::from_value(json!({
            "metadata": { "name": "work" },
            "spec": {
                "suspend": true,
                "template": { "spec": {
                    "restartPolicy": "Never",
                    "containers": [{ "name": "main", "image": TEST_IMAGE, "args": ["pause"] }],
                } },
            },
        }))
        .unwrap();
        jobs.create(&PostParams::default(), &job).await.unwrap();
        let suspended = || async {
            jobs.get("work")
                .await
                .unwrap()
                .spec
                .and_then(|spec| spec.suspend)
        };
        core.job_set_suspend(&id, NAMESPACE, "work", false)
            .await
            .unwrap();
        assert_eq!(suspended().await, Some(false));
        core.job_set_suspend(&id, NAMESPACE, "work", true)
            .await
            .unwrap();
        assert_eq!(suspended().await, Some(true));
    })
    .await;
}

#[tokio::test]
#[ignore = "needs the sextant-e2e kind cluster"]
async fn the_default_ingress_class_moves() {
    const OLD: &str = "sextant-test-class-old";
    const NEW: &str = "sextant-test-class-new";
    let (core, id, _root) = connected_kind().await;
    let client = core.cluster_client(&id).unwrap();
    let classes: Api<IngressClass> = Api::all(client.clone());
    for name in [OLD, NEW] {
        let _ = classes.delete(name, &DeleteParams::default()).await;
        let class: IngressClass = serde_json::from_value(json!({
            "metadata": { "name": name },
            "spec": { "controller": "sextant.dev/test" },
        }))
        .unwrap();
        classes
            .create(&PostParams::default(), &class)
            .await
            .unwrap();
    }
    let mark = Patch::Merge(json!({ "metadata": { "annotations": { DEFAULT_CLASS: "true" } } }));
    classes
        .patch(OLD, &PatchParams::default(), &mark)
        .await
        .unwrap();

    let test = async {
        core.ingress_class_set_default(&id, NEW).await.unwrap();
        let annotations = |class: IngressClass| -> BTreeMap<String, String> {
            class.metadata.annotations.unwrap_or_default()
        };
        let new = annotations(classes.get(NEW).await.unwrap());
        assert_eq!(new.get(DEFAULT_CLASS).map(String::as_str), Some("true"));
        let old = annotations(classes.get(OLD).await.unwrap());
        assert!(!old.contains_key(DEFAULT_CLASS), "{old:?}");
    };
    let result = AssertUnwindSafe(test).catch_unwind().await;
    for name in [OLD, NEW] {
        let _ = classes.delete(name, &DeleteParams::default()).await;
    }
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}

#[tokio::test]
#[ignore = "needs the sextant-e2e kind cluster"]
async fn a_saved_kubeconfig_acts_as_the_service_account() {
    const NAMESPACE: &str = "sextant-test-actions-token";
    let (core, id, root) = connected_kind().await;
    let client = core.cluster_client(&id).unwrap();
    in_namespace(&client, NAMESPACE, async {
        let accounts: Api<ServiceAccount> = Api::namespaced(client.clone(), NAMESPACE);
        let account = ServiceAccount {
            metadata: ObjectMeta {
                name: Some("reader".into()),
                ..ObjectMeta::default()
            },
            ..ServiceAccount::default()
        };
        accounts
            .create(&PostParams::default(), &account)
            .await
            .unwrap();
        let dest = root.path().join("reader.kubeconfig");
        let saved = core
            .service_account_kubeconfig_save(&id, NAMESPACE, "reader", &dest, Some(600))
            .await
            .unwrap();
        assert!(saved
            .expires_at
            .parse::<k8s_openapi::jiff::Timestamp>()
            .is_ok());

        let kubeconfig = Kubeconfig::read_from(&dest).unwrap();
        let config = Config::from_custom_kubeconfig(kubeconfig, &KubeConfigOptions::default())
            .await
            .unwrap();
        let as_reader = Client::try_from(config).unwrap();
        // It is really that account: it may connect, and may not read pods.
        as_reader.apiserver_version().await.unwrap();
        let pods: Api<Pod> = Api::namespaced(as_reader, NAMESPACE);
        let error = pods.list(&Default::default()).await.unwrap_err();
        let kube::Error::Api(status) = error else {
            panic!("{error:?}");
        };
        assert_eq!(status.code, 403);
        assert!(
            status.message.contains("serviceaccount"),
            "{}",
            status.message
        );
        assert!(status.message.contains("reader"), "{}", status.message);
    })
    .await;
}
