import type { Depth } from "./layout/neighborhood";

/** The cluster map of a cluster (spec E §5). */
export function mapPath(clusterId: string): string {
  return `/cluster/${encodeURIComponent(clusterId)}/map`;
}

/** The object map of a node, at the default depth unless one is given. */
export function objectMapPath(
  clusterId: string,
  focusId: string,
  depth?: Depth,
): string {
  const query = new URLSearchParams({ focus: focusId });
  if (depth !== undefined && depth !== 2) query.set("depth", String(depth));
  return `${mapPath(clusterId)}?${query.toString()}`;
}
