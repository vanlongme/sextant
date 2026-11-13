import type { StatusInfo } from "../columns";
import type { KubeObject } from "../objects";

type Obj = Pick<KubeObject, "metadata"> & Partial<KubeObject>;

/** What a Gateway API cell shows when it has nothing (spec E §13). */
export const NONE = "—";

// biome-ignore lint/suspicious/noExplicitAny: Kubernetes objects vary in shape.
function list<T = any>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/**
 * A condition's status in a Badge: "True" (ok), "False" (danger) or "Unknown"
 * (neutral), or null when the object has no such condition.
 */
export function conditionStatus(o: Obj, type: string): StatusInfo | null {
  const condition = list(o.status?.conditions).find((c) => c?.type === type);
  if (condition === undefined) return null;
  if (condition.status === "True") return { label: "True", tone: "ok" };
  if (condition.status === "False") return { label: "False", tone: "danger" };
  return { label: "Unknown", tone: "neutral" };
}

/** A Gateway's first address, then "+N" for the others, or "—". */
export function gatewayAddress(o: Obj): string {
  const values = list(o.status?.addresses)
    .map((a) => a?.value)
    .filter((v): v is string => typeof v === "string" && v !== "");
  if (values.length === 0) return NONE;
  return values.length === 1 ? values[0] : `${values[0]} +${values.length - 1}`;
}

/** An HTTPRoute's hostnames joined with ", ", or "—". */
export function routeHostnames(o: Obj): string {
  const names = list(o.spec?.hostnames).filter(
    (h): h is string => typeof h === "string",
  );
  return names.length > 0 ? names.join(", ") : NONE;
}

/**
 * An HTTPRoute's parents as `‹namespace›/‹name›`, with the route's namespace when a
 * reference gives none, joined with ", ", or "—".
 */
export function routeParents(o: Obj): string {
  const parents = list(o.spec?.parentRefs)
    .filter((p) => typeof p?.name === "string")
    .map((p) => `${p.namespace ?? o.metadata.namespace ?? ""}/${p.name}`);
  return parents.length > 0 ? parents.join(", ") : NONE;
}
