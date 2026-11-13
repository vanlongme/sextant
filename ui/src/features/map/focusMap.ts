import { useMemo } from "react";
import { type GraphEntry, useGraph } from "../../stores/graph";
import { type Depth, neighborhood } from "./layout/neighborhood";
import { buildModel, type MapModel } from "./model";

/** The kind, namespace and name of a node id, `‹Kind›/‹namespace›/‹name›` (spec E §4.4). */
export function idParts(id: string): {
  kind: string;
  namespace: string;
  name: string;
} {
  const first = id.indexOf("/");
  const second = first < 0 ? -1 : id.indexOf("/", first + 1);
  if (second < 0) return { kind: "", namespace: "", name: id };
  return {
    kind: id.slice(0, first),
    namespace: id.slice(first + 1, second),
    name: id.slice(second + 1),
  };
}

/**
 * The namespaces an object map subscribes with (spec E §10): the focus's, or every
 * namespace for a load balancer or another object outside the namespaces.
 */
export function focusNamespaces(focusId: string): string[] | null {
  const { kind, namespace } = idParts(focusId);
  return kind === "LoadBalancer" || namespace === "" ? null : [namespace];
}

/** The `depth` query parameter: 1, 2 or all, and 2 for anything else. */
export function parseDepth(value: string | null): Depth {
  if (value === "1") return 1;
  if (value === "all") return "all";
  return 2;
}

export interface FocusMap {
  graph: GraphEntry & { retry(): void };
  model: MapModel | null;
  /** The neighbourhood of the focus, or none while loading or when it is gone. */
  ids: string[];
  /** A snapshot came and the focus is not in it. */
  gone: boolean;
}

/**
 * The graph around one object, for the object map and the drawer tab: the focus's
 * view (spec E §4.7), then its neighbourhood (§7.2).
 */
export function useFocusMap(
  clusterId: string,
  focusId: string,
  depth: Depth,
): FocusMap {
  const namespaces = useMemo(() => focusNamespaces(focusId), [focusId]);
  const graph = useGraph(clusterId, namespaces);
  const snapshot = graph.snapshot;
  const model = useMemo(
    () => (snapshot ? buildModel(snapshot.nodes, snapshot.edges) : null),
    [snapshot],
  );
  const gone = model !== null && !model.byId.has(focusId);
  const ids = useMemo(
    () =>
      model === null || !model.byId.has(focusId)
        ? []
        : neighborhood(model, focusId, depth),
    [model, focusId, depth],
  );
  return { graph, model, ids, gone };
}
