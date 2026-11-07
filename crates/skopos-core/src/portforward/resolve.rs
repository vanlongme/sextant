//! Which pod and port a forward's connection goes to (F13). A name and a Service's pod are
//! resolved again for each connection, so a forward survives pod replacement.

use k8s_openapi::api::core::v1::{Pod, Service};
use kube::api::{GetParams, ListParams};
use kube::core::{Request, Resource};
use kube::Client;
use serde_json::Value;

use super::{PortForwardKind, PortForwardPort, PortForwardSpec};
use crate::error::{CoreResult, ErrorCode, IpcError};
use crate::resources::invalid;

fn not_found(message: String) -> IpcError {
    IpcError::new(ErrorCode::NotFound, message)
}

/// A port name in the pod's containers.
fn named_container_port(pod: &Value, name: &str) -> Option<u16> {
    pod.pointer("/spec/containers")?
        .as_array()?
        .iter()
        .filter_map(|container| container.get("ports").and_then(Value::as_array))
        .flatten()
        .find(|port| port.get("name").and_then(Value::as_str) == Some(name))?
        .get("containerPort")
        .and_then(Value::as_u64)
        .and_then(|port| u16::try_from(port).ok())
}

fn pod_port(pod: &Value, port: &PortForwardPort) -> CoreResult<u16> {
    match port {
        PortForwardPort::Number(number) => Ok(*number),
        PortForwardPort::Name(name) => named_container_port(pod, name)
            .ok_or_else(|| not_found(format!("the pod has no port named {name}"))),
    }
}

/// A port entry's `targetPort`, which defaults to its `port`.
fn target_of(entry: &Value) -> Option<PortForwardPort> {
    match entry.get("targetPort") {
        Some(Value::Number(number)) => number
            .as_u64()
            .and_then(|port| u16::try_from(port).ok())
            .map(PortForwardPort::Number),
        Some(Value::String(name)) => Some(PortForwardPort::Name(name.clone())),
        _ => entry
            .get("port")
            .and_then(Value::as_u64)
            .and_then(|port| u16::try_from(port).ok())
            .map(PortForwardPort::Number),
    }
}

/// Finds the Service port a forward means, and returns what it targets on the pod. A number
/// is a Service `port`, as `kubectl port-forward service/x` takes it, else a numeric
/// `targetPort`. A name is the port's `name`, else a named `targetPort`.
fn service_target(service: &Value, wanted: &PortForwardPort) -> CoreResult<PortForwardPort> {
    let ports = service
        .pointer("/spec/ports")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    let found = match wanted {
        PortForwardPort::Number(number) => {
            let number = u64::from(*number);
            ports
                .iter()
                .find(|entry| entry.get("port").and_then(Value::as_u64) == Some(number))
                .or_else(|| {
                    ports.iter().find(|entry| {
                        entry.get("targetPort").and_then(Value::as_u64) == Some(number)
                    })
                })
        }
        PortForwardPort::Name(name) => ports
            .iter()
            .find(|entry| entry.get("name").and_then(Value::as_str) == Some(name))
            .or_else(|| {
                ports
                    .iter()
                    .find(|entry| entry.get("targetPort").and_then(Value::as_str) == Some(name))
            }),
    };
    found
        .and_then(target_of)
        .ok_or_else(|| not_found(format!("the service has no port {wanted}")))
}

/// `k=v,k2=v2` from `spec.selector`. A Service without one has no pods of its own.
fn service_selector(service: &Value) -> CoreResult<String> {
    let selector = service
        .pointer("/spec/selector")
        .and_then(Value::as_object)
        .filter(|selector| !selector.is_empty())
        .ok_or_else(|| invalid("the service has no pod selector"))?;
    let parts: Vec<String> = selector
        .iter()
        .filter_map(|(key, value)| value.as_str().map(|value| format!("{key}={value}")))
        .collect();
    Ok(parts.join(","))
}

fn is_ready(pod: &Value) -> bool {
    if pod.pointer("/metadata/deletionTimestamp").is_some() {
        return false;
    }
    pod.pointer("/status/conditions")
        .and_then(Value::as_array)
        .is_some_and(|conditions| {
            conditions.iter().any(|condition| {
                condition.get("type").and_then(Value::as_str) == Some("Ready")
                    && condition.get("status").and_then(Value::as_str) == Some("True")
            })
        })
}

/// The first Ready pod by name, so that connections stay on one pod while it lasts.
fn choose_ready_pod(pods: &[Value]) -> Option<&Value> {
    pods.iter().filter(|pod| is_ready(pod)).min_by_key(|pod| {
        pod.pointer("/metadata/name")
            .and_then(Value::as_str)
            .unwrap_or_default()
    })
}

async fn read_json(client: &Client, request: http::Request<Vec<u8>>) -> Result<Value, kube::Error> {
    client.request(request).await
}

/// The pod and port a connection goes to right now.
pub(super) async fn resolve(client: &Client, spec: &PortForwardSpec) -> CoreResult<(String, u16)> {
    let namespace = spec.target.namespace.as_str();
    let name = spec.target.name.as_str();
    let get = GetParams::default();
    match spec.target.kind {
        PortForwardKind::Pod => {
            let request = Request::new(Pod::url_path(&(), Some(namespace)))
                .get(name, &get)
                .map_err(kube::Error::BuildRequest)?;
            let pod = read_json(client, request).await?;
            Ok((name.to_owned(), pod_port(&pod, &spec.target_port)?))
        }
        PortForwardKind::Service => {
            let request = Request::new(Service::url_path(&(), Some(namespace)))
                .get(name, &get)
                .map_err(kube::Error::BuildRequest)?;
            let service = read_json(client, request).await?;
            let target = service_target(&service, &spec.target_port)?;
            let params = ListParams::default().labels(&service_selector(&service)?);
            let request = Request::new(Pod::url_path(&(), Some(namespace)))
                .list(&params)
                .map_err(kube::Error::BuildRequest)?;
            let listed = read_json(client, request).await?;
            let items = listed
                .get("items")
                .and_then(Value::as_array)
                .map_or(&[][..], Vec::as_slice);
            let pod = choose_ready_pod(items)
                .ok_or_else(|| not_found(format!("the service {name} has no ready pod")))?;
            let pod_name = pod
                .pointer("/metadata/name")
                .and_then(Value::as_str)
                .ok_or_else(|| not_found(format!("the service {name} has no ready pod")))?;
            Ok((pod_name.to_owned(), pod_port(pod, &target)?))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn number(port: u16) -> PortForwardPort {
        PortForwardPort::Number(port)
    }

    fn name(port: &str) -> PortForwardPort {
        PortForwardPort::Name(port.to_owned())
    }

    fn service() -> Value {
        json!({ "spec": {
            "selector": { "app": "web", "tier": "a" },
            "ports": [
                { "name": "http", "port": 80, "targetPort": "web" },
                { "name": "admin", "port": 81, "targetPort": 9000 },
                { "port": 82 },
            ],
        } })
    }

    fn ready_pod(pod_name: &str) -> Value {
        json!({
            "metadata": { "name": pod_name },
            "spec": { "containers": [
                { "ports": [{ "name": "other", "containerPort": 1 }] },
                { "ports": [{ "name": "web", "containerPort": 8080 }] },
            ] },
            "status": { "conditions": [
                { "type": "Scheduled", "status": "True" },
                { "type": "Ready", "status": "True" },
            ] },
        })
    }

    #[test]
    fn a_number_is_a_service_port_else_a_target_port() {
        assert_eq!(
            service_target(&service(), &number(80)).unwrap(),
            name("web")
        );
        assert_eq!(
            service_target(&service(), &number(81)).unwrap(),
            number(9000)
        );
        assert_eq!(
            service_target(&service(), &number(9000)).unwrap(),
            number(9000)
        );
    }

    #[test]
    fn a_missing_target_port_defaults_to_the_port() {
        assert_eq!(service_target(&service(), &number(82)).unwrap(), number(82));
    }

    #[test]
    fn a_name_is_a_port_name_else_a_named_target_port() {
        assert_eq!(
            service_target(&service(), &name("http")).unwrap(),
            name("web")
        );
        assert_eq!(
            service_target(&service(), &name("admin")).unwrap(),
            number(9000)
        );
        assert_eq!(
            service_target(&service(), &name("web")).unwrap(),
            name("web")
        );
    }

    #[test]
    fn a_port_the_service_does_not_have_is_not_found() {
        for wanted in [number(1), name("none")] {
            let error = service_target(&service(), &wanted).unwrap_err();
            assert_eq!(error.code, ErrorCode::NotFound);
        }
    }

    #[test]
    fn a_named_port_is_looked_up_in_every_container() {
        assert_eq!(pod_port(&ready_pod("p"), &name("web")).unwrap(), 8080);
        assert_eq!(pod_port(&ready_pod("p"), &number(7)).unwrap(), 7);
        let error = pod_port(&ready_pod("p"), &name("none")).unwrap_err();
        assert_eq!(error.code, ErrorCode::NotFound);
    }

    #[test]
    fn the_selector_is_rendered_and_a_service_without_one_is_refused() {
        assert_eq!(service_selector(&service()).unwrap(), "app=web,tier=a");
        let error = service_selector(&json!({ "spec": {} })).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput);
    }

    #[test]
    fn only_a_ready_pod_that_is_not_deleting_is_chosen() {
        let mut deleting = ready_pod("a-deleting");
        deleting["metadata"]["deletionTimestamp"] = json!("2026-01-01T00:00:00Z");
        let mut unready = ready_pod("b-unready");
        unready["status"]["conditions"][1]["status"] = json!("False");
        let pods = [deleting, unready, ready_pod("d"), ready_pod("c")];
        let chosen = choose_ready_pod(&pods).unwrap();
        assert_eq!(chosen["metadata"]["name"], "c");
        assert!(choose_ready_pod(&pods[..2]).is_none());
    }
}
