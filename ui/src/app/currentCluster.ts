import { useMemo } from "react";
import { useMatch } from "react-router";
import type { ConnectionState } from "../ipc/generated/ConnectionState";
import { useCatalog } from "../stores/catalog";

export interface CurrentCluster {
  id: string;
  /** The catalog name, or "Cluster" while the id is not in the catalog. */
  name: string;
  state: ConnectionState;
}

const DISCONNECTED: ConnectionState = { status: "disconnected" };

/** The cluster of the current route, or null off cluster routes. */
export function useCurrentCluster(): CurrentCluster | null {
  const id = useMatch("/cluster/:id/*")?.params.id ?? null;
  const entry = useCatalog((s) =>
    id === null ? undefined : s.clusters.find((c) => c.id === id),
  );
  return useMemo(
    () =>
      id === null
        ? null
        : {
            id,
            name: entry?.name ?? "Cluster",
            state: entry?.state ?? DISCONNECTED,
          },
    [id, entry],
  );
}
