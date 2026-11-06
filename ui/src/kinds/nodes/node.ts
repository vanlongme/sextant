import type { StatusInfo } from "../columns";
import type { KubeObject } from "../objects";

export interface Taint {
  key: string;
  value?: string;
  effect: string;
}

/** What `kubectl get nodes` prints: Ready or NotReady, plus SchedulingDisabled when cordoned. */
export function nodeStatus(o: KubeObject): StatusInfo {
  const conditions: { type?: string; status?: string }[] = Array.isArray(
    o.status?.conditions,
  )
    ? o.status.conditions
    : [];
  const ready = conditions.find((c) => c.type === "Ready");
  const base = !ready
    ? "Unknown"
    : ready.status === "True"
      ? "Ready"
      : "NotReady";
  const cordoned = Boolean(o.spec?.unschedulable);
  const label = cordoned ? `${base},SchedulingDisabled` : base;
  if (base === "NotReady") return { label, tone: "danger" };
  if (base === "Unknown") return { label, tone: "neutral" };
  return { label, tone: cordoned ? "warn" : "ok" };
}

const ROLE_PREFIX = "node-role.kubernetes.io/";

export function nodeRoles(o: KubeObject): string {
  const roles = new Set<string>();
  for (const [key, value] of Object.entries(o.metadata.labels ?? {})) {
    if (key.startsWith(ROLE_PREFIX)) {
      const role = key.slice(ROLE_PREFIX.length);
      if (role) roles.add(role);
    } else if (key === "kubernetes.io/role" && value) {
      roles.add(value);
    }
  }
  return roles.size === 0 ? "<none>" : [...roles].sort().join(",");
}

export function taintText(t: Taint): string {
  return `${t.key}${t.value ? `=${t.value}` : ""}:${t.effect}`;
}

export function nodeTaints(o: KubeObject): Taint[] {
  return Array.isArray(o.spec?.taints) ? o.spec.taints : [];
}

export function internalIp(o: KubeObject): string | undefined {
  const addresses: { type?: string; address?: string }[] = Array.isArray(
    o.status?.addresses,
  )
    ? o.status.addresses
    : [];
  return addresses.find((a) => a.type === "InternalIP")?.address;
}
