import type { StatusInfo } from "../columns";
import type { KubeObject } from "../objects";
import { type LabelSelector, selectorText } from "../selectors";

type Obj = Pick<KubeObject, "metadata"> & Partial<KubeObject>;

// biome-ignore lint/suspicious/noExplicitAny: Kubernetes objects vary in shape.
function list<T = any>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

export function servicePorts(o: Obj): string {
  return list(o.spec?.ports)
    .map((p) => {
      const node = p.nodePort ? `:${p.nodePort}` : "";
      return `${p.port}${node}/${p.protocol ?? "TCP"}`;
    })
    .join(",");
}

function loadBalancerAddresses(o: Obj): string[] {
  return list(o.status?.loadBalancer?.ingress)
    .map((i) => i.ip || i.hostname)
    .filter((v): v is string => Boolean(v));
}

/** As kubectl prints the EXTERNAL-IP column. */
export function serviceExternalIp(o: Obj): string {
  const external: string[] = list(o.spec?.externalIPs);
  switch (o.spec?.type) {
    case "ExternalName":
      return o.spec?.externalName || "<none>";
    case "LoadBalancer": {
      const all = [...loadBalancerAddresses(o), ...external];
      return all.length > 0 ? all.join(",") : "<pending>";
    }
    default:
      return external.length > 0 ? external.join(",") : "<none>";
  }
}

export function serviceStatus(o: Obj): StatusInfo {
  return o.spec?.type === "LoadBalancer" && serviceExternalIp(o) === "<pending>"
    ? { label: "Pending", tone: "warn" }
    : { label: "Active", tone: "ok" };
}

export function ingressHosts(o: Obj): string {
  const hosts = list(o.spec?.rules)
    .map((r) => r?.host)
    .filter((h): h is string => Boolean(h));
  return hosts.length > 0 ? hosts.join(",") : "*";
}

export function ingressAddress(o: Obj): string {
  return loadBalancerAddresses(o).join(",");
}

export function ingressPorts(o: Obj): string {
  return list(o.spec?.tls).length > 0 ? "80, 443" : "80";
}

export interface IngressBackend {
  service?: { name?: string; port?: { number?: number; name?: string } };
  resource?: { kind?: string; name?: string };
}

/** `<service>:<port>` or `<resource kind>/<name>`. */
export function backendText(backend: IngressBackend | undefined): string {
  if (!backend) return "";
  if (backend.service) {
    const port = backend.service.port;
    return `${backend.service.name ?? ""}:${port?.number ?? port?.name ?? ""}`;
  }
  if (backend.resource) {
    return `${backend.resource.kind ?? ""}/${backend.resource.name ?? ""}`;
  }
  return "";
}

export interface IngressRoute {
  host: string;
  path: string;
  pathType: string;
  backend: string;
}

export function ingressRoutes(o: Obj): IngressRoute[] {
  return list(o.spec?.rules).flatMap((rule) =>
    list(rule?.http?.paths).map((p) => ({
      host: rule.host || "*",
      path: p.path || "/",
      pathType: p.pathType ?? "",
      backend: backendText(p.backend),
    })),
  );
}

export function ingressClass(o: Obj): string | undefined {
  return (
    o.spec?.ingressClassName ||
    o.metadata.annotations?.["kubernetes.io/ingress.class"] ||
    undefined
  );
}

export function isDefaultIngressClass(o: Obj): boolean {
  return (
    o.metadata.annotations?.["ingressclass.kubernetes.io/is-default-class"] ===
    "true"
  );
}

export function slicePorts(o: Obj): string {
  return list(o.ports)
    .map((p) => `${p.port}/${p.protocol ?? "TCP"}`)
    .join(",");
}

export function sliceEndpoints(o: Obj): string {
  return list(o.endpoints)
    .flatMap((e) => list<string>(e?.addresses))
    .join(",");
}

export interface PolicyPeer {
  ipBlock?: { cidr?: string; except?: string[] };
  podSelector?: LabelSelector;
  namespaceSelector?: LabelSelector;
}

function selector(s: LabelSelector | undefined): string {
  return selectorText(s).join(", ");
}

export function policyPeerText(peer: PolicyPeer): string {
  if (peer.ipBlock) {
    const except = list<string>(peer.ipBlock.except);
    return `CIDR ${peer.ipBlock.cidr ?? ""}${
      except.length > 0 ? ` except ${except.join(", ")}` : ""
    }`;
  }
  const { podSelector: pod, namespaceSelector: ns } = peer;
  const podText = pod && selector(pod) ? `pods ${selector(pod)}` : "all pods";
  if (ns) {
    const nsText = selector(ns)
      ? `namespaces ${selector(ns)}`
      : "all namespaces";
    return `${podText} in ${nsText}`;
  }
  if (pod) return `${podText} in this namespace`;
  return "";
}

export function policyPortText(port: {
  protocol?: string;
  port?: number | string;
  endPort?: number;
}): string {
  const protocol = port.protocol ?? "TCP";
  if (port.port === undefined || port.port === null) {
    return `${protocol} all ports`;
  }
  return `${protocol} ${port.port}${port.endPort ? `-${port.endPort}` : ""}`;
}

/** `<kind>/<name>`, or an empty string when the class has none. */
export function ingressClassParameters(o: Obj): string {
  const p = o.spec?.parameters;
  return p?.kind && p?.name ? `${p.kind}/${p.name}` : "";
}
