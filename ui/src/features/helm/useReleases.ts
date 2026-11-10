import { useEffect } from "react";
import { useClusterState } from "../../stores/clusters";
import { type ReleasesSlice, useHelm } from "../../stores/helm";
import { useUiState } from "../../stores/uiState";
import { namespaceFilterKey } from "../resources/NamespaceFilter";

/**
 * The namespace selection the resource lists use (empty is All), its setter, and
 * whether the saved selection was read yet.
 */
export function useNamespaceSelection(
  clusterId: string,
): [string[], (next: string[]) => void, boolean] {
  return useUiState<string[]>(namespaceFilterKey(clusterId), []);
}

/** The connected cluster's namespaces, for the namespace filter's options. */
export function useClusterNamespaces(clusterId: string): string[] {
  const state = useClusterState(clusterId);
  return state.status === "connected" ? state.info.namespaces : [];
}

/**
 * Watches the cluster's releases while mounted (spec §5.2). `namespaces` is the
 * selection, empty for All; undefined waits until the saved selection is read.
 */
export function useWatchReleases(
  clusterId: string,
  namespaces: string[] | undefined,
): ReleasesSlice | undefined {
  const watch = useHelm((s) => s.watchReleases);
  const asked = namespaces === undefined ? null : JSON.stringify(namespaces);
  useEffect(() => {
    if (asked === null) return;
    const chosen = JSON.parse(asked) as string[];
    return watch(clusterId, chosen.length === 0 ? null : chosen);
  }, [clusterId, asked, watch]);
  return useHelm((s) => s.releases[clusterId]);
}
