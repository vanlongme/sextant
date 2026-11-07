//! Port-forwards (F13). Definitions persist and never autostart. Status lives in memory and
//! every change is published as `CoreEvent::PortForwardsChanged`.
//!
//! These are not sessions. A page reload leaves them running, because `portforward_list`
//! lets the new page find them. Disconnect and quit stop them through the cluster's token.

mod resolve;

use std::fmt;
use std::net::Ipv4Addr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use dashmap::DashMap;
use k8s_openapi::api::core::v1::Pod;
use kube::{Api, Client};
use serde::{Deserialize, Serialize};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast;
use tokio::task::{JoinHandle, JoinSet};
use tokio_util::sync::CancellationToken;
use ts_rs::TS;

use crate::app_core::{AppCore, CoreEvent};
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::kubeconfig::ClusterId;
use crate::resources::{invalid, is_path_segment};
use crate::sessions::random_hex;
use crate::store::JsonStore;

/// How long a stopping forward may take to let go of its local port.
const STOP_LIMIT: Duration = Duration::from_secs(2);
/// After a connection's data ended, how long its error may take to arrive.
const ERROR_WAIT: Duration = Duration::from_millis(500);
const ACCEPT_PAUSE: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum PortForwardKind {
    Pod,
    Service,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardTarget {
    pub kind: PortForwardKind,
    pub namespace: String,
    pub name: String,
}

/// A number, or a name resolved per connection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(untagged)]
pub enum PortForwardPort {
    Number(u16),
    Name(String),
}

impl fmt::Display for PortForwardPort {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PortForwardPort::Number(number) => write!(f, "{number}"),
            PortForwardPort::Name(name) => write!(f, "{name}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardSpec {
    pub cluster_id: ClusterId,
    pub target: PortForwardTarget,
    pub target_port: PortForwardPort,
    /// `None` means a random port.
    pub local_port: Option<u16>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum PortForwardState {
    #[default]
    Stopped,
    Starting,
    Running,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PortForward {
    #[serde(flatten)]
    #[ts(flatten)]
    pub spec: PortForwardSpec,
    pub id: String,
    pub state: PortForwardState,
    pub bound_port: Option<u16>,
    /// Why it failed, or what the last connection ran into.
    pub message: Option<String>,
    pub active_connections: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Definition {
    id: String,
    spec: PortForwardSpec,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct Definitions {
    forwards: Vec<Definition>,
}

#[derive(Debug, Default)]
struct Status {
    state: PortForwardState,
    bound_port: Option<u16>,
    message: Option<String>,
    active_connections: u32,
    /// Which start this status belongs to. A task from an earlier one must not touch it.
    run: u64,
    token: Option<CancellationToken>,
    task: Option<JoinHandle<()>>,
}

pub(crate) struct PortForwards {
    definitions: JsonStore<Definitions>,
    statuses: DashMap<String, Status>,
    next_run: AtomicU64,
    events: broadcast::Sender<CoreEvent>,
}

impl PortForwards {
    pub(crate) fn new(
        definitions: JsonStore<Definitions>,
        events: broadcast::Sender<CoreEvent>,
    ) -> Self {
        PortForwards {
            definitions,
            statuses: DashMap::new(),
            next_run: AtomicU64::new(1),
            events,
        }
    }

    fn describe(&self, definition: Definition) -> PortForward {
        let status = self.statuses.get(&definition.id);
        let status = status.as_deref();
        PortForward {
            spec: definition.spec,
            id: definition.id,
            state: status.map_or(PortForwardState::Stopped, |status| status.state),
            bound_port: status.and_then(|status| status.bound_port),
            message: status.and_then(|status| status.message.clone()),
            active_connections: status.map_or(0, |status| status.active_connections),
        }
    }

    fn list(&self) -> Vec<PortForward> {
        self.definitions
            .get()
            .forwards
            .into_iter()
            .map(|definition| self.describe(definition))
            .collect()
    }

    fn find(&self, id: &str) -> Option<PortForward> {
        self.definitions
            .get()
            .forwards
            .into_iter()
            .find(|definition| definition.id == id)
            .map(|definition| self.describe(definition))
    }

    fn publish(&self) {
        // No subscribers is fine: the page reads the list when it loads.
        let _ = self.events.send(CoreEvent::PortForwardsChanged {
            forwards: self.list(),
        });
    }

    /// Marks a forward as starting, unless it already is or is running.
    fn begin(&self, id: &str, token: &CancellationToken) -> Option<u64> {
        let mut status = self.statuses.entry(id.to_owned()).or_default();
        if matches!(
            status.state,
            PortForwardState::Starting | PortForwardState::Running
        ) {
            return None;
        }
        let run = self.next_run.fetch_add(1, Ordering::Relaxed);
        *status = Status {
            state: PortForwardState::Starting,
            run,
            token: Some(token.clone()),
            ..Status::default()
        };
        Some(run)
    }

    /// Changes the status if it still belongs to this run, and publishes the change.
    fn update_run(&self, id: &str, run: u64, change: impl FnOnce(&mut Status)) -> bool {
        let updated = match self.statuses.get_mut(id) {
            Some(mut status) if status.run == run => {
                change(&mut status);
                true
            }
            _ => false,
        };
        if updated {
            self.publish();
        }
        updated
    }

    fn fail_run(&self, id: &str, run: u64, error: &IpcError) {
        self.update_run(id, run, |status| {
            status.state = PortForwardState::Failed;
            status.message = Some(error.message.clone());
            status.bound_port = None;
            status.token = None;
        });
    }

    /// Cancels a forward and waits until it has let go of its port.
    async fn stop(&self, id: &str) {
        let task = self.statuses.get_mut(id).and_then(|mut status| {
            status.run = self.next_run.fetch_add(1, Ordering::Relaxed);
            status.state = PortForwardState::Stopped;
            status.bound_port = None;
            status.message = None;
            status.active_connections = 0;
            if let Some(token) = status.token.take() {
                token.cancel();
            }
            status.task.take()
        });
        if let Some(task) = task {
            let _ = tokio::time::timeout(STOP_LIMIT, task).await;
        }
    }
}

fn check_spec(spec: &PortForwardSpec) -> CoreResult<()> {
    if !is_path_segment(&spec.target.namespace) || !is_path_segment(&spec.target.name) {
        return Err(invalid("the namespace or name is not valid"));
    }
    match &spec.target_port {
        PortForwardPort::Number(0) => return Err(invalid("the target port cannot be 0")),
        PortForwardPort::Name(name) if name.is_empty() => {
            return Err(invalid("the target port has no name"));
        }
        _ => {}
    }
    if spec.local_port == Some(0) {
        return Err(invalid(
            "the local port cannot be 0; leave it out for a random one",
        ));
    }
    Ok(())
}

/// What the tasks of one running forward share.
#[derive(Clone)]
struct RunningForward {
    forwards: Arc<PortForwards>,
    id: String,
    run: u64,
    client: Client,
    spec: PortForwardSpec,
    token: CancellationToken,
}

impl RunningForward {
    fn set_message(&self, error: &IpcError) {
        self.forwards.update_run(&self.id, self.run, |status| {
            status.message = Some(error.message.clone());
        });
    }

    fn count_connection(&self, opened: bool) {
        self.forwards.update_run(&self.id, self.run, |status| {
            if opened {
                status.active_connections += 1;
            } else {
                status.active_connections = status.active_connections.saturating_sub(1);
            }
        });
    }

    /// Carries one connection. Resolving here is what survives pod replacement.
    async fn carry(&self, mut socket: TcpStream) -> CoreResult<()> {
        let (pod, port) = resolve::resolve(&self.client, &self.spec).await?;
        let pods: Api<Pod> = Api::namespaced(self.client.clone(), &self.spec.target.namespace);
        let mut forwarder = pods.portforward(&pod, &[port]).await?;
        let lost = || {
            IpcError::new(
                ErrorCode::Internal,
                "the forward has no stream for the port",
            )
        };
        let mut upstream = forwarder.take_stream(port).ok_or_else(lost)?;
        let error = forwarder.take_error(port).ok_or_else(lost)?;
        tokio::pin!(error);
        let reported = tokio::select! {
            () = self.token.cancelled() => None,
            reported = &mut error => reported,
            // Either side closing abruptly is what connections do, so only the error the
            // API server reports for the pod's port counts.
            _ = tokio::io::copy_bidirectional(&mut socket, &mut upstream) => {
                tokio::time::timeout(ERROR_WAIT, &mut error).await.unwrap_or(None)
            }
        };
        forwarder.abort();
        match reported {
            Some(message) => Err(IpcError::new(ErrorCode::Internal, message)),
            None => Ok(()),
        }
    }

    async fn serve(self, listener: TcpListener) {
        let mut connections = JoinSet::new();
        loop {
            tokio::select! {
                () = self.token.cancelled() => break,
                Some(_) = connections.join_next() => {}
                accepted = listener.accept() => match accepted {
                    Ok((socket, _)) => {
                        let forward = self.clone();
                        connections.spawn(async move {
                            forward.count_connection(true);
                            if let Err(error) = forward.carry(socket).await {
                                forward.set_message(&error);
                            }
                            forward.count_connection(false);
                        });
                    }
                    Err(error) => {
                        self.set_message(&error.into());
                        tokio::time::sleep(ACCEPT_PAUSE).await;
                    }
                },
            }
        }
        drop(listener);
        connections.shutdown().await;
        // Still this run means the cluster went away rather than a stop command.
        self.forwards.update_run(&self.id, self.run, |status| {
            status.state = PortForwardState::Stopped;
            status.bound_port = None;
            status.active_connections = 0;
            status.token = None;
            status.task = None;
        });
    }
}

impl AppCore {
    pub fn portforward_list(&self) -> Vec<PortForward> {
        self.portforwards().list()
    }

    /// Saves a definition. It does not start it.
    pub fn portforward_add(&self, spec: PortForwardSpec) -> CoreResult<PortForward> {
        check_spec(&spec)?;
        let forwards = self.portforwards();
        let id = format!("pf-{}", random_hex());
        forwards.definitions.update(|definitions| {
            definitions.forwards.push(Definition {
                id: id.clone(),
                spec,
            });
        })?;
        forwards.publish();
        forwards
            .find(&id)
            .ok_or_else(|| IpcError::new(ErrorCode::Internal, "the forward was not saved"))
    }

    /// Starts a forward. If it is running or starting, returns it as it is.
    pub async fn portforward_start(&self, id: &str) -> CoreResult<PortForward> {
        let forwards = self.portforwards();
        let forward = forwards
            .find(id)
            .ok_or_else(|| IpcError::new(ErrorCode::NotFound, format!("no port-forward {id}")))?;
        let spec = forward.spec.clone();
        let token = self.cluster_cancel_token(&spec.cluster_id)?;
        let Some(run) = forwards.begin(id, &token) else {
            return Ok(forward);
        };
        forwards.publish();
        if let Err(error) = self.start_run(id, run, spec, token).await {
            forwards.fail_run(id, run, &error);
            return Err(error);
        }
        forwards
            .find(id)
            .ok_or_else(|| IpcError::new(ErrorCode::NotFound, format!("no port-forward {id}")))
    }

    async fn start_run(
        &self,
        id: &str,
        run: u64,
        spec: PortForwardSpec,
        token: CancellationToken,
    ) -> CoreResult<()> {
        let client = self.cluster_client(&spec.cluster_id)?;
        // A stop during the checks has moved the status to another run, so the update below
        // does nothing. A cluster disconnect leaves the run as it is, so it ends here as stopped.
        tokio::select! {
            () = token.cancelled() => {
                self.portforwards().update_run(id, run, |status| {
                    status.state = PortForwardState::Stopped;
                    status.bound_port = None;
                    status.token = None;
                });
                return Ok(());
            }
            resolved = resolve::resolve(&client, &spec) => { resolved?; }
        }
        let requested = spec.local_port.unwrap_or(0);
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, requested))
            .await
            .map_err(|_| invalid(format!("local port {requested} is not available")))?;
        let bound = listener.local_addr()?.port();
        let running = RunningForward {
            forwards: self.portforwards().clone(),
            id: id.to_owned(),
            run,
            client,
            spec,
            token: token.clone(),
        };
        let task = tokio::spawn(running.serve(listener));
        // A stop since `begin` has moved the status to another run, and has cancelled the token,
        // so the task is already on its way out. A cluster disconnect cancels the token without
        // changing the run, and the task may have finished before this update, so the token
        // decides inside the same closure: a cancelled run ends as stopped, never as running.
        self.portforwards().update_run(id, run, |status| {
            if token.is_cancelled() {
                status.state = PortForwardState::Stopped;
                status.bound_port = None;
                status.active_connections = 0;
                status.token = None;
                status.task = None;
            } else {
                status.state = PortForwardState::Running;
                status.bound_port = Some(bound);
                status.task = Some(task);
            }
        });
        Ok(())
    }

    /// Stops a forward. Safe to repeat, and an unknown id is ignored.
    pub async fn portforward_stop(&self, id: &str) {
        let forwards = self.portforwards();
        forwards.stop(id).await;
        forwards.publish();
    }

    /// Stops a forward and removes its definition. Safe to repeat.
    pub async fn portforward_remove(&self, id: &str) -> CoreResult<()> {
        let forwards = self.portforwards();
        forwards.stop(id).await;
        forwards.statuses.remove(id);
        forwards.definitions.update(|definitions| {
            definitions
                .forwards
                .retain(|definition| definition.id != id);
        })?;
        forwards.publish();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn spec() -> PortForwardSpec {
        PortForwardSpec {
            cluster_id: serde_json::from_value(json!("c1")).unwrap(),
            target: PortForwardTarget {
                kind: PortForwardKind::Service,
                namespace: "default".into(),
                name: "web".into(),
            },
            target_port: PortForwardPort::Name("http".into()),
            local_port: None,
        }
    }

    #[test]
    fn a_forward_serializes_as_the_spec_and_its_status_side_by_side() {
        let forward = PortForward {
            spec: spec(),
            id: "pf-1".into(),
            state: PortForwardState::Running,
            bound_port: Some(8080),
            message: None,
            active_connections: 2,
        };
        assert_eq!(
            serde_json::to_value(&forward).unwrap(),
            json!({
                "clusterId": "c1",
                "target": { "kind": "service", "namespace": "default", "name": "web" },
                "targetPort": "http",
                "localPort": null,
                "id": "pf-1",
                "state": "running",
                "boundPort": 8080,
                "message": null,
                "activeConnections": 2,
            })
        );
    }

    #[test]
    fn a_target_port_is_a_number_or_a_name() {
        let parse = |value| serde_json::from_value::<PortForwardPort>(value).unwrap();
        assert_eq!(parse(json!(80)), PortForwardPort::Number(80));
        assert_eq!(parse(json!("http")), PortForwardPort::Name("http".into()));
        assert!(serde_json::from_value::<PortForwardPort>(json!(70000)).is_err());
    }

    #[test]
    fn specs_that_cannot_work_are_refused() {
        assert!(check_spec(&spec()).is_ok());
        let mut bad = spec();
        bad.target.name = "a/b".into();
        assert!(check_spec(&bad).is_err());
        let mut bad = spec();
        bad.target_port = PortForwardPort::Number(0);
        assert!(check_spec(&bad).is_err());
        let mut bad = spec();
        bad.target_port = PortForwardPort::Name(String::new());
        assert!(check_spec(&bad).is_err());
        let mut bad = spec();
        bad.local_port = Some(0);
        assert!(check_spec(&bad).is_err());
    }
}
