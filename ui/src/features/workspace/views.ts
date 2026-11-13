import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import { eventLastSeen } from "../../kinds/cluster/cluster";
import type { KubeObject } from "../../kinds/objects";

/** Core v1 Events: the Workspace's Overview and Events views watch them. */
export const EVENTS: ResourceRef = {
  group: "",
  version: "v1",
  plural: "events",
  kind: "Event",
  namespaced: true,
};

const HOUR_MS = 60 * 60 * 1000;

/**
 * Events seen in the last hour, newest first, at most `limit`; with `warnings`,
 * only Warning events (spec E §15.5).
 */
export function recentEvents(
  items: KubeObject[],
  now: number,
  options: { limit: number; warnings?: boolean },
): KubeObject[] {
  return items
    .filter((e) => !options.warnings || e.type === "Warning")
    .map((e) => ({ e, at: Date.parse(eventLastSeen(e) ?? "") }))
    .filter(({ at }) => !Number.isNaN(at) && now - at <= HOUR_MS)
    .sort((a, b) => b.at - a.at)
    .slice(0, options.limit)
    .map(({ e }) => e);
}

/** The first container's image, then "+N" for the other containers. */
export function podImage(pod: KubeObject): string {
  const containers: { image?: string }[] = Array.isArray(pod.spec?.containers)
    ? pod.spec.containers
    : [];
  const [first, ...rest] = containers;
  if (!first?.image) return "";
  return rest.length > 0 ? `${first.image} +${rest.length}` : first.image;
}

/** "1 pod", "12 pods". */
export function podCount(n: number): string {
  return n === 1 ? "1 pod" : `${n} pods`;
}

/** The Pod drawer in the full cluster screen. */
export function podDrawerPath(clusterId: string, pod: KubeObject): string {
  const key = `${pod.metadata.namespace ?? ""}/${pod.metadata.name}`;
  return `/cluster/${encodeURIComponent(clusterId)}/r/core/pods?object=${encodeURIComponent(key)}`;
}
