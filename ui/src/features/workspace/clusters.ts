import type { ConnectionState } from "../../ipc/generated/ConnectionState";
import { useCatalog } from "../../stores/catalog";
import { VIEW_LABELS, type WorkspaceView } from "./layout";

const DISCONNECTED: ConnectionState = { status: "disconnected" };

/** The catalog name of a cluster, or "Cluster" while the id is not in the catalog. */
export function useClusterName(clusterId: string): string {
  return useCatalog(
    (s) => s.clusters.find((c) => c.id === clusterId)?.name ?? "Cluster",
  );
}

/** The live connection state of a cluster, as the catalog store holds it. */
export function useWorkspaceClusterState(clusterId: string): ConnectionState {
  return useCatalog(
    (s) => s.clusters.find((c) => c.id === clusterId)?.state ?? DISCONNECTED,
  );
}

/** "prod · Pods": a tab's label (spec E §15.3). */
export function tabLabel(name: string, view: WorkspaceView): string {
  return `${name} · ${VIEW_LABELS[view]}`;
}
