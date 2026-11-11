import { useEffect, useMemo } from "react";
import type { ClusterInfo } from "../../ipc/generated/ClusterInfo";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import type { UsageItem } from "../../ipc/generated/UsageItem";
import type { UsageOf } from "../../ipc/generated/UsageOf";
import type { UsageView } from "../../kinds/usageColumns";
import { useClusterState } from "../../stores/clusters";
import { ensureProvider, useMetrics } from "../../stores/metrics";
import { useUsageWatches } from "./hooks";

const NO_USAGE: UsageView = { items: null, notServed: false };

/** What a list reads from metrics.k8s.io: core Pods and Nodes only. */
function usageOf(resource: ResourceRef | null): UsageOf | null {
  if (resource === null || resource.group !== "") return null;
  if (resource.plural === "pods") return "pods";
  if (resource.plural === "nodes") return "nodes";
  return null;
}

/** The namespaces a list reads, null standing for every namespace. */
function scopesOf(
  of: UsageOf | null,
  namespaces: string[],
  info: ClusterInfo | null,
): (string | null)[] {
  if (of !== "pods") return [null];
  if (namespaces.length > 0) return namespaces;
  if (info?.namespacesRestricted) return info.namespaces;
  return [null];
}

/**
 * The CPU and Memory a Pods or Nodes list shows (spec §11), or undefined for any
 * other list. It polls only while the list is on screen, the cluster is connected
 * and the provider is known and not `none`. Pods are read per namespace the list
 * is filtered to, or per namespace the cluster allows when its namespaces are
 * restricted, and otherwise across the cluster.
 */
export function useListUsage(
  clusterId: string,
  resource: ResourceRef | null,
  namespaces: string[],
): UsageView | undefined {
  const of = usageOf(resource);
  const state = useClusterState(clusterId);
  const info = state.status === "connected" ? state.info : null;
  const provider = useMetrics((s) => s.providers[clusterId]);
  const notServed = useMetrics((s) => s.usageNotServed[clusterId] === true);
  const wanted = of !== null && info !== null;

  useEffect(() => {
    if (wanted && provider === undefined) ensureProvider(clusterId);
  }, [wanted, provider, clusterId]);

  const kind = provider?.value?.kind;
  const polling = wanted && kind !== undefined && kind !== "none";
  const slices = useUsageWatches(
    clusterId,
    of ?? "pods",
    scopesOf(of, namespaces, info),
    polling,
  );

  return useMemo(() => {
    if (of === null) return undefined;
    if (!polling) return NO_USAGE;
    const items = new Map<string, UsageItem>();
    for (const slice of slices) {
      for (const item of slice.value?.items ?? []) {
        const key =
          of === "nodes" ? item.name : `${item.namespace ?? ""}/${item.name}`;
        items.set(key, item);
      }
    }
    return { items, notServed };
  }, [of, polling, slices, notServed]);
}
