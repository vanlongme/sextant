//! One-request actions on workloads, pods, CronJobs, nodes, Secrets and ConfigMaps.
//! Scale and evict go through subresources; the others patch the object.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use k8s_openapi::jiff::Timestamp;
use kube::api::{Patch, PatchParams, PostParams};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use ts_rs::TS;

use super::ops::{invalid, object_request, send};
use super::types::ResourceRef;
use crate::app_core::AppCore;
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::kubeconfig::ClusterId;

const RESTARTED_AT: &str = "kubectl.kubernetes.io/restartedAt";
const INSTANTIATE: &str = "cronjob.kubernetes.io/instantiate";
const NAME_LIMIT: usize = 63;
const MANUAL_SUFFIX_LENGTH: usize = "-manual-xxxxx".len();

/// One Secret value, shown because the user asked for that key.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SecretValue {
    /// The text, or the base64 form when the bytes are not UTF-8.
    pub value: String,
    pub binary: bool,
}

/// A change to one key of a Secret or ConfigMap. `None` removes the key.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct DataChange {
    pub key: String,
    pub value: Option<String>,
}

fn scalable(r: &ResourceRef) -> bool {
    r.group == "apps"
        && matches!(
            r.plural.as_str(),
            "deployments" | "statefulsets" | "replicasets"
        )
}

fn restartable(r: &ResourceRef) -> bool {
    r.group == "apps"
        && matches!(
            r.plural.as_str(),
            "deployments" | "statefulsets" | "daemonsets"
        )
}

/// The Job a manual run creates, as `kubectl create job --from=cronjob/<name>` builds it.
fn manual_job(cronjob: &Value, suffix: &str) -> CoreResult<Value> {
    let text = |pointer: &str| cronjob.pointer(pointer).and_then(Value::as_str);
    let (Some(name), Some(uid)) = (text("/metadata/name"), text("/metadata/uid")) else {
        return Err(IpcError::new(
            ErrorCode::Internal,
            "the CronJob has no name or uid",
        ));
    };
    let Some(template) = cronjob.pointer("/spec/jobTemplate") else {
        return Err(invalid("the CronJob has no job template"));
    };
    let base: String = name
        .chars()
        .take(NAME_LIMIT - MANUAL_SUFFIX_LENGTH)
        .collect();
    let mut annotations = template
        .pointer("/metadata/annotations")
        .cloned()
        .unwrap_or_else(|| json!({}));
    annotations[INSTANTIATE] = json!("manual");
    let mut metadata = json!({
        "name": format!("{}-manual-{suffix}", base.trim_end_matches('-')),
        "annotations": annotations,
        "ownerReferences": [{
            "apiVersion": "batch/v1", "kind": "CronJob", "name": name, "uid": uid,
            "controller": true, "blockOwnerDeletion": true,
        }],
    });
    if let Some(labels) = template.pointer("/metadata/labels") {
        metadata["labels"] = labels.clone();
    }
    Ok(json!({
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": metadata,
        "spec": template.get("spec").cloned().unwrap_or_else(|| json!({})),
    }))
}

/// A merge patch of `data`. The `resourceVersion` makes the server refuse it when
/// the object has changed since the user started editing.
fn data_patch(resource_version: &str, changes: &[DataChange], encode: bool) -> Value {
    let data: serde_json::Map<String, Value> = changes
        .iter()
        .map(|change| {
            let value = change.value.as_ref().map_or(Value::Null, |text| {
                Value::String(if encode {
                    STANDARD.encode(text)
                } else {
                    text.clone()
                })
            });
            (change.key.clone(), value)
        })
        .collect();
    json!({ "metadata": { "resourceVersion": resource_version }, "data": data })
}

fn core_resource(
    kind: &str,
    plural: &str,
    group: &str,
    version: &str,
    namespaced: bool,
) -> ResourceRef {
    ResourceRef {
        group: group.into(),
        version: version.into(),
        plural: plural.into(),
        kind: kind.into(),
        namespaced,
    }
}

/// The POST that asks the API server to evict a pod.
pub(super) fn eviction_request(namespace: &str, name: &str) -> CoreResult<http::Request<Vec<u8>>> {
    let pods = core_resource("Pod", "pods", "", "v1", true);
    let request = object_request(&pods, Some(namespace), name)?;
    let body = json!({
        "apiVersion": "policy/v1",
        "kind": "Eviction",
        "metadata": { "name": name, "namespace": namespace },
    });
    let body = serde_json::to_vec(&body).map_err(|e| invalid(e.to_string()))?;
    let request = request
        .create_subresource("eviction", name, &PostParams::default(), body)
        .map_err(kube::Error::BuildRequest)?;
    Ok(request)
}

impl AppCore {
    async fn patch_object(
        &self,
        id: &ClusterId,
        r: &ResourceRef,
        namespace: Option<&str>,
        name: &str,
        patch: Patch<Value>,
    ) -> CoreResult<()> {
        let request = object_request(r, namespace, name)?;
        let client = self.cluster_client(id)?;
        send(
            &client,
            request.patch(name, &PatchParams::default(), &patch),
        )
        .await?;
        Ok(())
    }

    pub async fn workload_scale(
        &self,
        id: &ClusterId,
        r: &ResourceRef,
        namespace: &str,
        name: &str,
        replicas: i32,
    ) -> CoreResult<()> {
        if replicas < 0 {
            return Err(invalid("the replica count cannot be negative"));
        }
        if !scalable(r) {
            return Err(invalid(format!("{} cannot be scaled", r.kind)));
        }
        let request = object_request(r, Some(namespace), name)?;
        let client = self.cluster_client(id)?;
        let patch = Patch::Merge(json!({ "spec": { "replicas": replicas } }));
        send(
            &client,
            request.patch_subresource("scale", name, &PatchParams::default(), &patch),
        )
        .await?;
        Ok(())
    }

    pub async fn workload_restart(
        &self,
        id: &ClusterId,
        r: &ResourceRef,
        namespace: &str,
        name: &str,
    ) -> CoreResult<()> {
        if !restartable(r) {
            return Err(invalid(format!("{} cannot be restarted", r.kind)));
        }
        let stamp = Timestamp::now().to_string();
        let patch = json!({ "spec": { "template": { "metadata": {
            "annotations": { RESTARTED_AT: stamp },
        } } } });
        self.patch_object(id, r, Some(namespace), name, Patch::Strategic(patch))
            .await
    }

    pub async fn pod_evict(&self, id: &ClusterId, namespace: &str, name: &str) -> CoreResult<()> {
        let request = eviction_request(namespace, name)?;
        let client = self.cluster_client(id)?;
        send(&client, Ok(request)).await?;
        Ok(())
    }

    /// Creates a Job from the CronJob's template and returns the Job's name.
    pub async fn cronjob_trigger(
        &self,
        id: &ClusterId,
        namespace: &str,
        name: &str,
    ) -> CoreResult<String> {
        let cronjobs = core_resource("CronJob", "cronjobs", "batch", "v1", true);
        let cronjob = self
            .fetch_object(id, &cronjobs, Some(namespace), name)
            .await?;
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| {
                elapsed.subsec_nanos() ^ (elapsed.as_secs() as u32)
            });
        let job = manual_job(&cronjob, &format!("{:05x}", nanos & 0xf_ffff))?;
        let jobs = core_resource("Job", "jobs", "batch", "v1", true);
        let request = object_request(&jobs, Some(namespace), "job")?;
        let body = serde_json::to_vec(&job).map_err(|e| invalid(e.to_string()))?;
        let client = self.cluster_client(id)?;
        let created = send(&client, request.create(&PostParams::default(), body)).await?;
        created
            .pointer("/metadata/name")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| IpcError::new(ErrorCode::Internal, "the API did not return the Job"))
    }

    pub async fn cronjob_set_suspend(
        &self,
        id: &ClusterId,
        namespace: &str,
        name: &str,
        suspend: bool,
    ) -> CoreResult<()> {
        let cronjobs = core_resource("CronJob", "cronjobs", "batch", "v1", true);
        let patch = Patch::Merge(json!({ "spec": { "suspend": suspend } }));
        self.patch_object(id, &cronjobs, Some(namespace), name, patch)
            .await
    }

    /// Cordons or uncordons a node. Uncordon removes the field, as `kubectl uncordon` does.
    pub async fn node_set_unschedulable(
        &self,
        id: &ClusterId,
        name: &str,
        unschedulable: bool,
    ) -> CoreResult<()> {
        let nodes = core_resource("Node", "nodes", "", "v1", false);
        let value = if unschedulable {
            json!(true)
        } else {
            Value::Null
        };
        let patch = Patch::Merge(json!({ "spec": { "unschedulable": value } }));
        self.patch_object(id, &nodes, None, name, patch).await
    }

    /// One key of a Secret, decoded.
    pub async fn secret_reveal(
        &self,
        id: &ClusterId,
        namespace: &str,
        name: &str,
        key: &str,
    ) -> CoreResult<SecretValue> {
        let secrets = core_resource("Secret", "secrets", "", "v1", true);
        let secret = self
            .fetch_object(id, &secrets, Some(namespace), name)
            .await?;
        let Some(encoded) = secret
            .get("data")
            .and_then(|data| data.get(key))
            .and_then(Value::as_str)
        else {
            return Err(IpcError::new(
                ErrorCode::NotFound,
                "the Secret has no such key",
            ));
        };
        let bytes = STANDARD
            .decode(encoded)
            .map_err(|_| IpcError::new(ErrorCode::Internal, "the Secret value is not base64"))?;
        Ok(match String::from_utf8(bytes) {
            Ok(value) => SecretValue {
                value,
                binary: false,
            },
            Err(_) => SecretValue {
                value: encoded.to_owned(),
                binary: true,
            },
        })
    }

    pub async fn secret_update(
        &self,
        id: &ClusterId,
        namespace: &str,
        name: &str,
        resource_version: &str,
        changes: Vec<DataChange>,
    ) -> CoreResult<()> {
        let secrets = core_resource("Secret", "secrets", "", "v1", true);
        self.update_data(
            id,
            &secrets,
            namespace,
            name,
            resource_version,
            &changes,
            true,
        )
        .await
    }

    pub async fn configmap_update(
        &self,
        id: &ClusterId,
        namespace: &str,
        name: &str,
        resource_version: &str,
        changes: Vec<DataChange>,
    ) -> CoreResult<()> {
        let configmaps = core_resource("ConfigMap", "configmaps", "", "v1", true);
        self.update_data(
            id,
            &configmaps,
            namespace,
            name,
            resource_version,
            &changes,
            false,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn update_data(
        &self,
        id: &ClusterId,
        r: &ResourceRef,
        namespace: &str,
        name: &str,
        resource_version: &str,
        changes: &[DataChange],
        encode: bool,
    ) -> CoreResult<()> {
        if resource_version.is_empty() {
            return Err(invalid("the resource version is missing"));
        }
        let patch = Patch::Merge(data_patch(resource_version, changes, encode));
        self.patch_object(id, r, Some(namespace), name, patch).await
    }
}
