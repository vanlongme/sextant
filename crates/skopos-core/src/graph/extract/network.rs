//! Services, Ingresses and the Gateway API kinds (spec E §4.5, §4.6).

use serde_json::Value;

use super::{condition, items, said, string_map, text, unique, Item, Said, Target};
use crate::graph::kinds::{Kind, GATEWAY_GROUP};
use crate::graph::types::{GraphRel, GraphStatus};

/// The addresses in `status.loadBalancer.ingress`, as IPs or host names.
fn balancer_addresses(object: &Value) -> Vec<String> {
    unique(
        items(object, "/status/loadBalancer/ingress")
            .iter()
            .filter_map(|entry| text(entry, "/ip").or_else(|| text(entry, "/hostname"))),
    )
}

pub(super) fn service(item: &mut Item, object: &Value) {
    item.status = GraphStatus::Nominal;
    let kind = text(object, "/spec/type").unwrap_or_else(|| "ClusterIP".to_owned());
    item.fact("Type", kind.clone());
    let ports: Vec<String> = items(object, "/spec/ports")
        .iter()
        .filter_map(|port| {
            let number = port["port"].as_i64()?;
            let protocol = text(port, "/protocol").unwrap_or_else(|| "TCP".to_owned());
            Some(format!("{number}/{protocol}"))
        })
        .collect();
    if !ports.is_empty() {
        item.fact("Ports", ports.join(", "));
    }
    let selector = string_map(&object["spec"]["selector"]);
    if selector.is_empty() {
        item.fact("Selector", "None");
    } else {
        let pairs: Vec<String> = selector.iter().map(|(k, v)| format!("{k}={v}")).collect();
        item.fact("Selector", pairs.join(", "));
        item.selector = Some(selector);
    }
    if kind == "LoadBalancer" {
        item.addresses = balancer_addresses(object);
    }
}

pub(super) fn ingress(item: &mut Item, object: &Value) {
    item.addresses = balancer_addresses(object);
    if item.addresses.is_empty() {
        item.status = GraphStatus::Warning;
        item.status_text = Some("No address yet".to_owned());
    } else {
        item.status = GraphStatus::Nominal;
    }
    let class = text(object, "/spec/ingressClassName")
        .or_else(|| text(object, "/metadata/annotations/kubernetes.io~1ingress.class"));
    item.fact_if("Class", class);
    let rules = items(object, "/spec/rules");
    let hosts = unique(rules.iter().filter_map(|rule| text(rule, "/host")));
    if !hosts.is_empty() {
        item.fact("Hosts", hosts.join(", "));
    }
    if !item.addresses.is_empty() {
        let address = item.addresses.join(", ");
        item.fact("Address", address);
    }
    let mut backends: Vec<String> = text(object, "/spec/defaultBackend/service/name")
        .into_iter()
        .collect();
    for rule in rules {
        for path in items(rule, "/http/paths") {
            backends.extend(text(path, "/backend/service/name"));
        }
    }
    for name in backends {
        item.refer(GraphRel::Routes, Kind::Service, &name);
    }
}

pub(super) fn gateway(item: &mut Item, object: &Value) {
    (item.status, item.status_text) = match said(condition(object, "Programmed")) {
        Said::True => (GraphStatus::Nominal, None),
        Said::False(reason) => (GraphStatus::Critical, reason),
        Said::Unknown => (GraphStatus::Warning, Some("Not programmed yet".to_owned())),
    };
    let class = text(object, "/spec/gatewayClassName");
    item.fact_if("Class", class.clone());
    item.addresses = unique(
        items(object, "/status/addresses")
            .iter()
            .filter_map(|address| text(address, "/value")),
    );
    if !item.addresses.is_empty() {
        let address = item.addresses.join(", ");
        item.fact("Address", address);
    }
    let listeners: Vec<String> = items(object, "/spec/listeners")
        .iter()
        .map(|listener| {
            let name = text(listener, "/name").unwrap_or_default();
            let port = listener["port"]
                .as_i64()
                .map(|p| p.to_string())
                .unwrap_or_default();
            let protocol = text(listener, "/protocol").unwrap_or_default();
            format!("{name}:{port}/{protocol}")
        })
        .collect();
    if !listeners.is_empty() {
        item.fact("Listeners", listeners.join(", "));
    }
    if let Some(class) = class {
        item.refer(GraphRel::Class, Kind::GatewayClass, &class);
    }
}

/// Spec E §4.6: any parent that refused it decides, then any that has not said.
fn route_status(route: &Value) -> (GraphStatus, Option<String>) {
    let answers: Vec<Said> = items(route, "/status/parents")
        .iter()
        .map(|parent| {
            said(
                items(parent, "/conditions")
                    .iter()
                    .find(|c| c["type"] == "Accepted"),
            )
        })
        .collect();
    if let Some(reason) = answers.iter().find_map(|answer| match answer {
        Said::False(reason) => Some(reason.clone()),
        _ => None,
    }) {
        return (GraphStatus::Critical, reason);
    }
    if !answers.is_empty() && answers.iter().all(|answer| *answer == Said::True) {
        return (GraphStatus::Nominal, None);
    }
    (GraphStatus::Warning, Some("Not accepted yet".to_owned()))
}

pub(super) fn http_route(item: &mut Item, object: &Value) {
    (item.status, item.status_text) = route_status(object);
    let hostnames = unique(
        items(object, "/spec/hostnames")
            .iter()
            .filter_map(|h| h.as_str().filter(|h| !h.is_empty()).map(str::to_owned)),
    );
    if !hostnames.is_empty() {
        item.fact("Hostnames", hostnames.join(", "));
    }

    let mut parents = Vec::new();
    for parent in items(object, "/spec/parentRefs") {
        let Some(name) = text(parent, "/name") else {
            continue;
        };
        let namespace = text(parent, "/namespace").unwrap_or_else(|| item.namespace.clone());
        parents.push(format!("{namespace}/{name}"));
        let kind = text(parent, "/kind").unwrap_or_else(|| "Gateway".to_owned());
        // An absent group means the Gateway API's; an empty one means the core group.
        let group = parent
            .get("group")
            .and_then(Value::as_str)
            .unwrap_or(GATEWAY_GROUP);
        if kind == "Gateway" && group == GATEWAY_GROUP {
            let target = Target {
                kind: Kind::Gateway,
                namespace,
                name,
            };
            item.refer_to(GraphRel::Routes, target, true);
        }
    }
    if !parents.is_empty() {
        item.fact("Parents", unique(parents).join(", "));
    }

    let mut backends = Vec::new();
    for rule in items(object, "/spec/rules") {
        for backend in items(rule, "/backendRefs") {
            let Some(name) = text(backend, "/name") else {
                continue;
            };
            backends.push(match backend["port"].as_i64() {
                Some(port) => format!("{name}:{port}"),
                None => name.clone(),
            });
            let kind = text(backend, "/kind").unwrap_or_else(|| "Service".to_owned());
            let group = backend.get("group").and_then(Value::as_str).unwrap_or("");
            if kind == "Service" && group.is_empty() {
                let namespace =
                    text(backend, "/namespace").unwrap_or_else(|| item.namespace.clone());
                let target = Target {
                    kind: Kind::Service,
                    namespace,
                    name,
                };
                item.refer_to(GraphRel::Routes, target, false);
            }
        }
    }
    if !backends.is_empty() {
        item.fact("Backends", unique(backends).join(", "));
    }
}

pub(super) fn gateway_class(item: &mut Item, object: &Value) {
    let accepted = condition(object, "Accepted");
    (item.status, item.status_text) = match said(accepted) {
        Said::True => (GraphStatus::Nominal, None),
        Said::False(reason) => (GraphStatus::Critical, reason),
        Said::Unknown => (
            GraphStatus::Warning,
            Some("Waiting for the controller".to_owned()),
        ),
    };
    item.fact_if("Controller", text(object, "/spec/controllerName"));
    item.fact_if("Accepted", accepted.and_then(|c| text(c, "/status")));
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::graph::extract::test_support::{facts, item, refs};
    use crate::graph::kinds::Kind;
    use crate::graph::types::{GraphRel, GraphStatus};

    #[test]
    fn a_service_has_its_type_ports_selector_and_balancer() {
        let service = item(
            Kind::Service,
            json!({
                "metadata": { "name": "web", "namespace": "a" },
                "spec": {
                    "type": "LoadBalancer",
                    "selector": { "tier": "api", "app": "web" },
                    "ports": [{ "port": 80 }, { "port": 443, "protocol": "TCP" }, { "port": 53, "protocol": "UDP" }, { "name": "x" }],
                },
                "status": { "loadBalancer": { "ingress": [{ "ip": "10.0.0.9" }, { "hostname": "lb.example.com" }, { "ip": "10.0.0.9" }] } },
            }),
        );
        assert_eq!(service.status, GraphStatus::Nominal);
        assert_eq!(
            facts(&service),
            [
                ("Type", "LoadBalancer"),
                ("Ports", "80/TCP, 443/TCP, 53/UDP"),
                ("Selector", "app=web, tier=api"),
            ]
        );
        assert_eq!(service.selector.as_ref().map(|s| s.len()), Some(2));
        assert_eq!(service.addresses, ["10.0.0.9", "lb.example.com"]);

        let headless = item(
            Kind::Service,
            json!({
                "metadata": { "name": "db", "namespace": "a" },
                "spec": { "selector": {} },
                "status": { "loadBalancer": { "ingress": [{ "ip": "10.0.0.1" }] } },
            }),
        );
        assert_eq!(
            facts(&headless),
            [("Type", "ClusterIP"), ("Selector", "None")]
        );
        assert_eq!(headless.selector, None);
        assert!(
            headless.addresses.is_empty(),
            "only a LoadBalancer Service has a balancer"
        );
    }

    #[test]
    fn an_ingress_routes_to_its_backends() {
        let ingress = item(
            Kind::Ingress,
            json!({
                "metadata": { "name": "web", "namespace": "a", "annotations": { "kubernetes.io/ingress.class": "old" } },
                "spec": {
                    "ingressClassName": "nginx",
                    "defaultBackend": { "service": { "name": "fallback", "port": { "number": 80 } } },
                    "rules": [
                        { "host": "web.example.com", "http": { "paths": [
                            { "backend": { "service": { "name": "web", "port": { "number": 80 } } } },
                            { "backend": { "resource": { "kind": "Bucket", "name": "b" } } },
                        ] } },
                        { "host": "web.example.com", "http": { "paths": [{ "backend": { "service": { "name": "web" } } }] } },
                        { "http": { "paths": [{ "backend": { "service": { "name": "api" } } }] } },
                    ],
                },
                "status": { "loadBalancer": { "ingress": [{ "ip": "10.0.0.7" }] } },
            }),
        );
        assert_eq!(
            (ingress.status, ingress.status_text.as_deref()),
            (GraphStatus::Nominal, None)
        );
        assert_eq!(
            facts(&ingress),
            [
                ("Class", "nginx"),
                ("Hosts", "web.example.com"),
                ("Address", "10.0.0.7")
            ]
        );
        assert_eq!(ingress.addresses, ["10.0.0.7"]);
        assert_eq!(
            refs(&ingress),
            [
                (GraphRel::Routes, "Service/a/fallback".to_owned(), false),
                (GraphRel::Routes, "Service/a/web".to_owned(), false),
                (GraphRel::Routes, "Service/a/api".to_owned(), false),
            ]
        );

        let waiting = item(
            Kind::Ingress,
            json!({
                "metadata": { "name": "w", "namespace": "a", "annotations": { "kubernetes.io/ingress.class": "old" } },
            }),
        );
        assert_eq!(
            (waiting.status, waiting.status_text.as_deref()),
            (GraphStatus::Warning, Some("No address yet"))
        );
        assert_eq!(facts(&waiting), [("Class", "old")]);
    }

    fn gateway(conditions: serde_json::Value) -> serde_json::Value {
        json!({
            "metadata": { "name": "edge", "namespace": "infra" },
            "spec": {
                "gatewayClassName": "shared",
                "listeners": [{ "name": "http", "port": 80, "protocol": "HTTP" }, { "name": "https", "port": 443, "protocol": "HTTPS" }],
            },
            "status": { "conditions": conditions, "addresses": [{ "type": "IPAddress", "value": "10.0.0.9" }, { "value": "10.0.0.10" }] },
        })
    }

    #[test]
    fn a_gateway_reads_programmed_and_points_at_its_class() {
        let cases = [
            (
                json!([{ "type": "Programmed", "status": "True" }]),
                GraphStatus::Nominal,
                None,
            ),
            (
                json!([{ "type": "Programmed", "status": "False", "reason": "Invalid" }]),
                GraphStatus::Critical,
                Some("Invalid"),
            ),
            (
                json!([{ "type": "Programmed", "status": "False" }]),
                GraphStatus::Critical,
                None,
            ),
            (
                json!([{ "type": "Programmed", "status": "Unknown", "reason": "Pending" }]),
                GraphStatus::Warning,
                Some("Not programmed yet"),
            ),
            (json!([]), GraphStatus::Warning, Some("Not programmed yet")),
        ];
        for (conditions, status, text) in cases {
            let gateway = item(Kind::Gateway, gateway(conditions.clone()));
            assert_eq!(
                (gateway.status, gateway.status_text.as_deref()),
                (status, text),
                "{conditions}"
            );
        }
        let gateway = item(Kind::Gateway, gateway(json!([])));
        assert_eq!(
            facts(&gateway),
            [
                ("Class", "shared"),
                ("Address", "10.0.0.9, 10.0.0.10"),
                ("Listeners", "http:80/HTTP, https:443/HTTPS"),
            ]
        );
        assert_eq!(gateway.addresses, ["10.0.0.9", "10.0.0.10"]);
        assert_eq!(
            refs(&gateway),
            [(GraphRel::Class, "GatewayClass//shared".to_owned(), false)]
        );
    }

    #[test]
    fn a_route_defaults_its_parent_and_backend_references() {
        let route = item(
            Kind::HttpRoute,
            json!({
                "metadata": { "name": "web", "namespace": "a" },
                "spec": {
                    "hostnames": ["web.example.com"],
                    "parentRefs": [
                        { "name": "edge" },
                        { "name": "shared", "namespace": "infra", "sectionName": "http" },
                        { "name": "mesh", "kind": "Service", "group": "" },
                        { "name": "other", "group": "example.com" },
                    ],
                    "rules": [
                        { "backendRefs": [{ "name": "web", "port": 80 }, { "name": "api", "namespace": "b", "port": 8080 }] },
                        { "backendRefs": [{ "name": "bucket", "kind": "Bucket", "group": "example.com" }, { "name": "web", "port": 80 }] },
                    ],
                },
            }),
        );
        assert_eq!(
            facts(&route),
            [
                ("Hostnames", "web.example.com"),
                ("Parents", "a/edge, infra/shared, a/mesh, a/other"),
                ("Backends", "web:80, api:8080, bucket"),
            ]
        );
        assert_eq!(
            refs(&route),
            [
                (GraphRel::Routes, "Gateway/a/edge".to_owned(), true),
                (GraphRel::Routes, "Gateway/infra/shared".to_owned(), true),
                (GraphRel::Routes, "Service/a/web".to_owned(), false),
                (GraphRel::Routes, "Service/b/api".to_owned(), false),
            ]
        );
    }

    fn route_with(parents: serde_json::Value) -> crate::graph::extract::Item {
        item(
            Kind::HttpRoute,
            json!({ "metadata": { "name": "r", "namespace": "a" }, "status": { "parents": parents } }),
        )
    }

    fn accepted(status: &str, reason: Option<&str>) -> serde_json::Value {
        json!({ "conditions": [{ "type": "Accepted", "status": status, "reason": reason }] })
    }

    #[test]
    fn a_route_reads_accepted_in_every_parent() {
        let cases = [
            (
                json!([accepted("True", None), accepted("True", None)]),
                GraphStatus::Nominal,
                None,
            ),
            (
                json!([
                    accepted("True", None),
                    accepted("False", Some("NotAllowedByListeners"))
                ]),
                GraphStatus::Critical,
                Some("NotAllowedByListeners"),
            ),
            (
                json!([accepted("Unknown", None), accepted("False", None)]),
                GraphStatus::Critical,
                None,
            ),
            (
                json!([accepted("True", None), accepted("Unknown", Some("Pending"))]),
                GraphStatus::Warning,
                Some("Not accepted yet"),
            ),
            (
                json!([accepted("True", None), { "conditions": [] }]),
                GraphStatus::Warning,
                Some("Not accepted yet"),
            ),
            (json!([]), GraphStatus::Warning, Some("Not accepted yet")),
        ];
        for (parents, status, text) in cases {
            let route = route_with(parents.clone());
            assert_eq!(
                (route.status, route.status_text.as_deref()),
                (status, text),
                "{parents}"
            );
        }
    }

    #[test]
    fn a_gateway_class_reads_accepted() {
        let class = |conditions: serde_json::Value| {
            item(
                Kind::GatewayClass,
                json!({
                    "metadata": { "name": "shared" },
                    "spec": { "controllerName": "example.com/gateway" },
                    "status": { "conditions": conditions },
                }),
            )
        };
        let accepted = class(json!([{ "type": "Accepted", "status": "True" }]));
        assert_eq!(
            (accepted.status, accepted.status_text.as_deref()),
            (GraphStatus::Nominal, None)
        );
        assert_eq!(
            facts(&accepted),
            [("Controller", "example.com/gateway"), ("Accepted", "True")]
        );
        let refused = class(
            json!([{ "type": "Accepted", "status": "False", "reason": "InvalidParameters" }]),
        );
        assert_eq!(
            (refused.status, refused.status_text.as_deref()),
            (GraphStatus::Critical, Some("InvalidParameters"))
        );
        let waiting =
            class(json!([{ "type": "Accepted", "status": "Unknown", "reason": "Pending" }]));
        assert_eq!(
            (waiting.status, waiting.status_text.as_deref()),
            (GraphStatus::Warning, Some("Waiting for the controller"))
        );
        assert_eq!(
            facts(&waiting),
            [
                ("Controller", "example.com/gateway"),
                ("Accepted", "Unknown")
            ]
        );
        let silent = class(json!(null));
        assert_eq!(
            silent.status_text.as_deref(),
            Some("Waiting for the controller")
        );
        assert_eq!(facts(&silent), [("Controller", "example.com/gateway")]);
    }
}
