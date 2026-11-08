//! Argo CD Application actions. They write the Application through the Kubernetes API, not
//! the Argo CD API server, so SkoposIDE needs no other login, and Kubernetes RBAC decides who
//! may. The logic follows how that API server writes an Application at v3.6.1
//! (`server/application/application.go`, `util/argo/argo.go`), credited in
//! `THIRD_PARTY_NOTICES.md`.

mod operation;
mod windows;

use std::time::Duration;

use kube::api::PostParams;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use super::ops::{object_request, send};
use super::types::ResourceRef;
use crate::app_core::AppCore;
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::kubeconfig::ClusterId;
use operation::{
    check_resources, refuse_if_deleting, refuse_if_running, rollback_operation, sync_operation,
    terminating, with_operation,
};
use windows::{has_sync_windows, project_location};

/// The `details` of the refusal that asks the user about sync windows.
pub const SYNC_WINDOWS_UNVERIFIED: &str = "syncWindowsUnverified";
/// How many times a write is tried in all while the Application keeps changing under it.
const ATTEMPTS: usize = 5;
const RETRY_DELAY: Duration = Duration::from_millis(100);

/// How the controller applies the manifests.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum ArgoSyncStrategy {
    /// Runs the sync hooks around the apply.
    Hook,
    /// Applies without hooks.
    Apply,
}

/// One resource of the Application to sync. An empty group is the core group.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ArgoSyncResource {
    pub group: String,
    pub kind: String,
    pub namespace: Option<String>,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ArgoSyncOptions {
    /// Refused on an Application with several sources. `None`: `targetRevision`.
    pub revision: Option<String>,
    pub prune: bool,
    pub dry_run: bool,
    pub force: bool,
    pub strategy: ArgoSyncStrategy,
    /// Empty: the Application's own `spec.syncPolicy.syncOptions`.
    pub sync_options: Vec<String>,
    /// `None`: every resource.
    pub resources: Option<Vec<ArgoSyncResource>>,
    pub acknowledge_sync_windows: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ArgoRollbackOptions {
    /// The `id` of an entry in `status.history`.
    #[ts(type = "number")]
    pub history_id: i64,
    pub prune: bool,
    pub dry_run: bool,
    pub acknowledge_sync_windows: bool,
}

fn argo_resource(kind: &str, plural: &str) -> ResourceRef {
    ResourceRef {
        group: "argoproj.io".into(),
        version: "v1alpha1".into(),
        plural: plural.into(),
        kind: kind.into(),
        namespaced: true,
    }
}

fn applications() -> ResourceRef {
    argo_resource("Application", "applications")
}

fn app_projects() -> ResourceRef {
    argo_resource("AppProject", "appprojects")
}

/// Whether to read the Application again after a write refused with `error`. A 409 means it
/// changed in between, which the controller does often.
fn again(error: &IpcError, attempt: &mut usize) -> bool {
    if error.code != ErrorCode::Conflict || *attempt >= ATTEMPTS {
        return false;
    }
    *attempt += 1;
    true
}

impl AppCore {
    /// PUTs an Application changed from what was read. It carries that read's
    /// `resourceVersion`, so the API server refuses it with 409 if the Application changed
    /// since. The CRD has no status subresource, so one PUT carries `operation` and `status`.
    async fn put_application(
        &self,
        id: &ClusterId,
        namespace: &str,
        name: &str,
        app: &Value,
    ) -> CoreResult<()> {
        let request = object_request(&applications(), Some(namespace), name)?;
        let client = self.cluster_client(id)?;
        let body = serde_json::to_vec(app).map_err(|_| {
            IpcError::new(ErrorCode::Internal, "the Application could not be encoded")
        })?;
        send(&client, request.replace(name, &PostParams::default(), body)).await?;
        Ok(())
    }

    /// Refuses with `syncWindowsUnverified` unless the user acknowledged, or the project is known
    /// to have no sync windows. A project that cannot be read counts as one that has them.
    async fn check_sync_windows(
        &self,
        id: &ClusterId,
        app: &Value,
        acknowledged: bool,
    ) -> CoreResult<()> {
        if acknowledged {
            return Ok(());
        }
        let (namespace, project) = project_location(app);
        let unverified = match self
            .fetch_object(id, &app_projects(), Some(&namespace), &project)
            .await
        {
            Ok(found) => has_sync_windows(&found),
            Err(error)
                if matches!(
                    error.code,
                    ErrorCode::NotFound | ErrorCode::Forbidden | ErrorCode::InvalidInput
                ) =>
            {
                true
            }
            Err(error) => return Err(error),
        };
        if unverified {
            return Err(IpcError::new(
                ErrorCode::Conflict,
                format!(
                    "the project {project} may have sync windows, which SkoposIDE does not check"
                ),
            )
            .with_details(SYNC_WINDOWS_UNVERIFIED));
        }
        Ok(())
    }

    /// Starts a sync, as the Argo CD API server does: it sets `operation`, clears
    /// `status.operationState`, and writes both in one PUT. The controller takes it from there,
    /// and removes `operation` when the sync ends.
    pub async fn argocd_sync(
        &self,
        id: &ClusterId,
        namespace: &str,
        name: &str,
        options: &ArgoSyncOptions,
    ) -> CoreResult<()> {
        check_resources(options)?;
        let mut attempt = 1;
        loop {
            let app = self
                .fetch_object(id, &applications(), Some(namespace), name)
                .await?;
            refuse_if_deleting(&app, name)?;
            refuse_if_running(&app, name)?;
            let operation = sync_operation(&app, options)?;
            self.check_sync_windows(id, &app, options.acknowledge_sync_windows)
                .await?;
            let app = with_operation(app, operation)?;
            match self.put_application(id, namespace, name, &app).await {
                Err(error) if again(&error, &mut attempt) => tokio::time::sleep(RETRY_DELAY).await,
                result => return result,
            }
        }
    }

    /// Returns to one deployment of `status.history` by starting a sync of that entry's
    /// revision and source. Refused while auto-sync is on, because auto-sync would undo it.
    pub async fn argocd_rollback(
        &self,
        id: &ClusterId,
        namespace: &str,
        name: &str,
        options: &ArgoRollbackOptions,
    ) -> CoreResult<()> {
        let mut attempt = 1;
        loop {
            let app = self
                .fetch_object(id, &applications(), Some(namespace), name)
                .await?;
            refuse_if_deleting(&app, name)?;
            let operation = rollback_operation(&app, options, name)?;
            refuse_if_running(&app, name)?;
            self.check_sync_windows(id, &app, options.acknowledge_sync_windows)
                .await?;
            let app = with_operation(app, operation)?;
            match self.put_application(id, namespace, name, &app).await {
                Err(error) if again(&error, &mut attempt) => tokio::time::sleep(RETRY_DELAY).await,
                result => return result,
            }
        }
    }

    /// Asks the controller to stop the operation in progress by setting its phase to
    /// `Terminating`. The controller ends the operation and removes `operation`.
    pub async fn argocd_terminate(
        &self,
        id: &ClusterId,
        namespace: &str,
        name: &str,
    ) -> CoreResult<()> {
        let mut attempt = 1;
        loop {
            let app = self
                .fetch_object(id, &applications(), Some(namespace), name)
                .await?;
            let app = terminating(app, name)?;
            match self.put_application(id, namespace, name, &app).await {
                Err(error) if again(&error, &mut attempt) => tokio::time::sleep(RETRY_DELAY).await,
                result => return result,
            }
        }
    }
}
