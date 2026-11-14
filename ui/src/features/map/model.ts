import type { GraphEdge } from "../../ipc/generated/GraphEdge";
import type { GraphNamespaceCount } from "../../ipc/generated/GraphNamespaceCount";
import type { GraphNode } from "../../ipc/generated/GraphNode";
import type { GraphRel } from "../../ipc/generated/GraphRel";
import { NAV_SECTIONS } from "../../kinds/nav";
import { levelOf, STATUS_TEXT } from "./layout/constants";

/** A real edge, or a bridge through hidden kinds (spec H62). */
export type MapEdge = GraphEdge & { via?: string[] };

/** The map draws at most this many nodes (spec E §9.2). */
export const MAX_NODES = 1500;
/** Force is offered up to this many drawn nodes. */
export const FORCE_MAX_NODES = 400;

/** One end of an edge as seen from a node. */
export interface Link {
  other: string;
  rel: GraphRel;
  /** True when the edge leaves this node. */
  out: boolean;
  /** The hidden kinds a bridged link passes through. */
  via?: string[];
}

/** A snapshot indexed for the layouts (spec E §6.3). Positions are not part of it. */
export interface MapModel {
  nodes: GraphNode[];
  byId: ReadonlyMap<string, GraphNode>;
  /** The edges whose two ends are nodes, in the snapshot's order. */
  edges: MapEdge[];
  outgoing: ReadonlyMap<string, MapEdge[]>;
  incoming: ReadonlyMap<string, MapEdge[]>;
}

export function buildModel(
  nodes: GraphNode[],
  edges: readonly MapEdge[],
): MapModel {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kept = edges.filter((e) => byId.has(e.from) && byId.has(e.to));
  const outgoing = new Map<string, MapEdge[]>();
  const incoming = new Map<string, MapEdge[]>();
  for (const e of kept) {
    outgoing.set(e.from, [...(outgoing.get(e.from) ?? []), e]);
    incoming.set(e.to, [...(incoming.get(e.to) ?? []), e]);
  }
  return { nodes, byId, edges: kept, outgoing, incoming };
}

/** A node's edges, outgoing first, each in the snapshot's order. */
export function linksOf(model: MapModel, id: string): Link[] {
  const via = (e: MapEdge) => (e.via ? { via: e.via } : {});
  return [
    ...(model.outgoing.get(id) ?? []).map((e) => ({
      other: e.to,
      rel: e.rel,
      out: true,
      ...via(e),
    })),
    ...(model.incoming.get(id) ?? []).map((e) => ({
      other: e.from,
      rel: e.rel,
      out: false,
      ...via(e),
    })),
  ];
}

/** The node, which every id the layouts get must have. */
export function nodeOf(model: MapModel, id: string): GraphNode {
  const node = model.byId.get(id);
  if (!node) throw new Error(`no node ${id}`);
  return node;
}

/** The node's status text, or the word for its status. */
export function statusLine(node: GraphNode): string {
  return node.statusText ?? STATUS_TEXT[node.status];
}

/** Kinds a namespace view brings in but never walks on from (spec E §4.7). */
const VIEW_STOPS: ReadonlySet<string> = new Set([
  "GatewayClass",
  "LoadBalancer",
]);

/**
 * The ids drawn when the namespaces in `hidden` are hidden, in the snapshot's order.
 * With nothing hidden, every node. Otherwise the nodes of the shown namespaces, then,
 * until nothing is added, every node joined to one of them by a `routes` or `class`
 * edge: the subscription's own rule (spec E §4.7), which also brings in the cluster-scoped
 * and load balancer nodes connected to what is shown. A GatewayClass or LoadBalancer is
 * brought in but never walked on from, because many objects share one.
 */
export function namespaceView(
  model: MapModel,
  hidden: ReadonlySet<string>,
): string[] {
  if (hidden.size === 0) return model.nodes.map((n) => n.id);
  const shown = new Set(
    model.nodes
      .filter((n) => n.namespace !== "" && !hidden.has(n.namespace))
      .map((n) => n.id),
  );
  const queue = [...shown];
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    for (const link of linksOf(model, id)) {
      if (link.rel !== "routes" && link.rel !== "class") continue;
      if (shown.has(link.other)) continue;
      shown.add(link.other);
      if (!VIEW_STOPS.has(nodeOf(model, link.other).kind))
        queue.push(link.other);
    }
  }
  return model.nodes.filter((n) => shown.has(n.id)).map((n) => n.id);
}

/** Ids sorted by level, then by name: the order of "the first node". */
export function levelSort(model: MapModel, ids: readonly string[]): string[] {
  return [...ids].sort((a, b) => {
    const na = nodeOf(model, a);
    const nb = nodeOf(model, b);
    return (
      levelOf(na.kind) - levelOf(nb.kind) ||
      na.name.localeCompare(nb.name) ||
      a.localeCompare(b)
    );
  });
}

/** The namespaces with a chip: every entry of `counts` but cluster scope, by name. */
export function chipNamespaces(counts: GraphNamespaceCount[]): string[] {
  return counts
    .map((c) => c.namespace)
    .filter((ns) => ns !== "")
    .sort((a, b) => a.localeCompare(b));
}

/** What to subscribe with: null when nothing is hidden, else the shown namespaces. */
export function subscribedNamespaces(
  namespaces: readonly string[],
  hidden: ReadonlySet<string>,
): string[] | null {
  if (hidden.size === 0) return null;
  return namespaces.filter((ns) => !hidden.has(ns));
}

/**
 * The namespaces to hide on a cluster whose whole graph holds more than `MAX_NODES`
 * nodes, or null when it does not. The one kept is the default namespace when it has
 * nodes, else the first namespace by name (spec E §9.2).
 */
export function autoHidden(
  counts: GraphNamespaceCount[],
  defaultNamespace: string | null,
): string[] | null {
  const total = counts.reduce((sum, c) => sum + c.nodes, 0);
  if (total <= MAX_NODES) return null;
  const names = chipNamespaces(counts);
  const keep =
    defaultNamespace !== null &&
    counts.some((c) => c.namespace === defaultNamespace && c.nodes > 0)
      ? defaultNamespace
      : names[0];
  return names.filter((ns) => ns !== keep);
}

/** True when the drawn set is over the cap and nothing is drawn. */
export function tooMany(ids: readonly string[]): boolean {
  return ids.length > MAX_NODES;
}

/** "1 resource", "1,742 resources". */
export function countText(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** What the cluster map summary counts against (spec H61). */
export interface SummaryScope {
  /** Every resource in the cluster's graph. */
  total: number;
  /** True while a namespace or a present kind is hidden. */
  filtering: boolean;
}

/**
 * The map summary of what is drawn: "‹X› resources · ‹N› namespaces · ‹K› kinds", with
 * "‹X› of ‹Y› resources" while filtering. Without a scope (the object map), only
 * "‹X› resources".
 */
export function summaryText(
  model: MapModel,
  ids: readonly string[],
  scope: SummaryScope | null,
): string {
  if (scope === null) return countText(ids.length, "resource", "resources");
  const nodes = ids.map((id) => nodeOf(model, id));
  const namespaces = new Set(
    nodes.map((n) => n.namespace).filter((ns) => ns !== ""),
  );
  const kinds = new Set(nodes.map((n) => n.kind));
  const resources = scope.filtering
    ? `${ids.length.toLocaleString("en-US")} of ${countText(scope.total, "resource", "resources")}`
    : countText(ids.length, "resource", "resources");
  return [
    resources,
    countText(namespaces.size, "namespace", "namespaces"),
    countText(kinds.size, "kind", "kinds"),
  ].join(" · ");
}

/** The summary's tooltip. */
export function summaryTitle(filtering: boolean): string {
  return filtering
    ? "Drawn now, of every resource in the cluster"
    : "Every resource in the cluster";
}

/** The Gateway API lists, which the sidebar shows under Custom Resources. */
const GATEWAY_LISTS: Readonly<Record<string, string>> = {
  gatewayclasses: "GatewayClasses",
  gateways: "Gateways",
  httproutes: "HTTPRoutes",
};

/**
 * The name of a list for "Open in ‹Plural›" and the missing-kinds note: the sidebar's
 * label, the Gateway API's, or the kind made plural. Without a kind, the plural.
 */
export function listLabel(plural: string, kind?: string): string {
  for (const section of NAV_SECTIONS) {
    for (const item of section.items) {
      if (item.type === "resource" && item.plural === plural) return item.label;
    }
  }
  const gateway = GATEWAY_LISTS[plural];
  if (gateway) return gateway;
  if (kind === undefined) return plural;
  if (kind.endsWith("s")) return `${kind}es`;
  if (kind.endsWith("y")) return `${kind.slice(0, -1)}ies`;
  return `${kind}s`;
}

/** The note for kinds the user cannot list (spec E §17). */
export function missingText(missing: readonly string[]): string {
  return `Not shown: you cannot list ${missing.map((p) => listLabel(p)).join(", ")}.`;
}
