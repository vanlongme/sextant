import { useEffect } from "react";
import { api } from "../../ipc/api";
import type { ClusterInfo } from "../../ipc/generated/ClusterInfo";
import { nodeStatus } from "../../kinds/nodes/node";
import { NODES } from "../../kinds/refs";
import { useCatalog } from "../../stores/catalog";
import { connectCluster } from "../../stores/clusters";
import { useResourceList } from "../../stores/resources";
import { useWorkspace } from "../../stores/workspace";
import type { WorkspaceTab } from "./layout";

/** Where "Open the full cluster screen" goes for a tab (spec E §15.4). */
export function fullScreenPath(tab: WorkspaceTab): string {
  const base = `/cluster/${encodeURIComponent(tab.clusterId)}`;
  if (tab.view === "pods") return `${base}/r/core/pods`;
  if (tab.view === "events") return `${base}/r/core/events`;
  return base;
}

export interface NodeReadiness {
  ready: number;
  total: number;
}

/**
 * "kind v1.33.1 · 2 of 2 nodes ready · namespace shop" (spec E §15.4). A part not
 * known yet is left out; `namespace` is undefined until the tab's pick is known,
 * and null for all namespaces.
 */
export function paneMeta(parts: {
  info: ClusterInfo | null;
  nodes: NodeReadiness | null;
  namespace: string | null | undefined;
}): string {
  const { info, nodes, namespace } = parts;
  return [
    info ? `${info.distribution} ${info.version}` : null,
    nodes ? `${nodes.ready} of ${nodes.total} nodes ready` : null,
    namespace === undefined
      ? null
      : namespace === null
        ? "all namespaces"
        : `namespace ${namespace}`,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

/** Ready and total Nodes of a connected cluster, or null until the list is in. */
export function useNodeReadiness(
  clusterId: string,
  connected: boolean,
): NodeReadiness | null {
  const list = useResourceList(clusterId, connected ? NODES : null);
  if (!connected || list.loading) return null;
  if (list.status === "notServed" || list.status === "forbidden") return null;
  const ready = list.items.filter(
    (n) => nodeStatus(n).label.split(",")[0] === "Ready",
  ).length;
  return { ready, total: list.items.length };
}

/**
 * The tab's namespace pick: undefined until known, null for all namespaces. It
 * starts on the cluster's default namespace from its settings.
 */
export function useTabNamespace(tab: WorkspaceTab): string | null | undefined {
  const picked = useWorkspace((s) => s.namespaces[tab.id]);
  useEffect(() => {
    if (useWorkspace.getState().namespaces[tab.id] !== undefined) return;
    let live = true;
    api
      .clusterSettingsGet(tab.clusterId)
      .then((settings) => settings.defaultNamespace)
      .catch(() => null)
      .then((namespace) => {
        const { namespaces, setNamespace } = useWorkspace.getState();
        if (live && namespaces[tab.id] === undefined) {
          setNamespace(tab.id, namespace);
        }
      });
    return () => {
      live = false;
    };
  }, [tab.id, tab.clusterId]);
  return picked;
}

/**
 * When a tab becomes active and its cluster is Disconnected, connect it with the
 * existing action (spec E §15.6). The caller mounts anew for each activation (its
 * key is the tab id). It waits for the catalog, and does not connect again when the
 * cluster is disconnected while the tab stays active.
 */
export function useConnectOnActivate(clusterId: string): void {
  const loaded = useCatalog((s) => !s.loading);
  useEffect(() => {
    if (!loaded) return;
    const cluster = useCatalog
      .getState()
      .clusters.find((c) => c.id === clusterId);
    if (cluster?.state.status === "disconnected") {
      void connectCluster(clusterId);
    }
  }, [clusterId, loaded]);
}
