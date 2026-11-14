import type { GraphNamespaceCount } from "../../ipc/generated/GraphNamespaceCount";
import { NAV_SECTIONS } from "../../kinds/nav";
import {
  buildModel,
  listLabel,
  type MapEdge,
  type MapModel,
  nodeOf,
} from "./model";

/** One kind of the Kinds dropdown. */
export interface KindRow {
  /** The node kind, as saved in `map.hiddenKinds.<clusterId>`. */
  kind: string;
  /** The sidebar's plural label. */
  label: string;
  nodes: number;
}

export interface KindGroup {
  id: string;
  label: string;
  kinds: KindRow[];
  nodes: number;
}

export interface TriggerText {
  label: string;
  title: string;
}

export type GroupState = "all" | "some" | "none";

const OUTSIDE = "LoadBalancer";

/**
 * The kinds present in the view, grouped by sidebar section in the sidebar's order (spec
 * H57). Kinds no section lists go to "Other"; load balancers to "Outside the cluster".
 */
export function kindGroups(
  model: MapModel,
  viewIds: readonly string[],
): KindGroup[] {
  const present = new Map<
    string,
    { group: string; plural: string; nodes: number }
  >();
  for (const id of viewIds) {
    const node = nodeOf(model, id);
    const entry = present.get(node.kind);
    if (entry) entry.nodes += 1;
    else
      present.set(node.kind, {
        group: node.group,
        plural: node.plural,
        nodes: 1,
      });
  }
  const placed = new Set<string>();
  const groups: KindGroup[] = [];
  const push = (id: string, label: string, kinds: KindRow[]) => {
    if (kinds.length === 0) return;
    groups.push({
      id,
      label,
      kinds,
      nodes: kinds.reduce((n, k) => n + k.nodes, 0),
    });
  };
  for (const section of NAV_SECTIONS) {
    const kinds: KindRow[] = [];
    for (const item of section.items) {
      if (item.type !== "resource") continue;
      for (const [kind, p] of present) {
        if (kind === OUTSIDE || placed.has(kind)) continue;
        if (p.group !== item.group || p.plural !== item.plural) continue;
        placed.add(kind);
        kinds.push({ kind, label: item.label, nodes: p.nodes });
      }
    }
    push(section.id, section.label, kinds);
  }
  const other = [...present]
    .filter(([kind]) => kind !== OUTSIDE && !placed.has(kind))
    .map(([kind, p]) => ({
      kind,
      label: listLabel(p.plural, kind),
      nodes: p.nodes,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  push("other", "Other", other);
  const outside = present.get(OUTSIDE);
  push(
    "outside",
    "Outside the cluster",
    outside
      ? [{ kind: OUTSIDE, label: "Load balancers", nodes: outside.nodes }]
      : [],
  );
  return groups;
}

/** The view without the nodes of hidden kinds. */
export function kindView(
  model: MapModel,
  viewIds: readonly string[],
  hidden: ReadonlySet<string>,
): string[] {
  if (hidden.size === 0) return [...viewIds];
  return viewIds.filter((id) => !hidden.has(nodeOf(model, id).kind));
}

/** The shown nodes with the real edges between them and the bridges (spec H62). */
export function visibleModel(
  model: MapModel,
  shownIds: readonly string[],
  bridges: readonly MapEdge[],
): MapModel {
  return buildModel(
    shownIds.map((id) => nodeOf(model, id)),
    [...model.edges, ...bridges],
  );
}

/**
 * Every resource of the cluster's graph. The backend's counts leave cluster scope out, so
 * the snapshot's cluster-scoped nodes are added.
 */
export function graphTotal(
  model: MapModel,
  counts: readonly GraphNamespaceCount[],
): number {
  const namespaced = counts.reduce((n, c) => n + c.nodes, 0);
  return namespaced + model.nodes.filter((n) => n.namespace === "").length;
}

/** The Namespaces trigger (spec H55). */
export function namespaceTrigger(
  all: readonly string[],
  hidden: ReadonlySet<string>,
): TriggerText {
  const shown = all.filter((ns) => !hidden.has(ns));
  if (shown.length === all.length)
    return { label: "All namespaces", title: "All namespaces" };
  if (shown.length === 0)
    return { label: "No namespaces", title: "No namespaces" };
  const title = `Namespaces: ${shown.join(", ")}`;
  if (shown.length === 1) return { label: shown[0], title };
  return { label: `${shown.length.toLocaleString("en-US")} namespaces`, title };
}

/** The Kinds trigger (spec H56). */
export function kindTrigger(
  groups: readonly KindGroup[],
  hidden: ReadonlySet<string>,
): TriggerText {
  const rows = groups.flatMap((g) => g.kinds);
  const off = rows.filter((r) => hidden.has(r.kind));
  if (off.length === 0) return { label: "All kinds", title: "All kinds" };
  const title = `Hidden: ${off.map((r) => r.label).join(", ")}`;
  if (off.length === rows.length) return { label: "No kinds", title };
  return {
    label: `${tally(rows.length - off.length, rows.length)} kinds`,
    title,
  };
}

/** "‹shown› of ‹all›". */
export function tally(shown: number, all: number): string {
  return `${shown.toLocaleString("en-US")} of ${all.toLocaleString("en-US")}`;
}

/** Select all: the hidden list without the listed rows. */
export function showListed(
  hidden: readonly string[],
  listed: readonly string[],
): string[] {
  const drop = new Set(listed);
  return [...new Set(hidden.filter((h) => !drop.has(h)))].sort();
}

/** Clear: the hidden list with the listed rows, sorted and unique. */
export function hideListed(
  hidden: readonly string[],
  listed: readonly string[],
): string[] {
  return [...new Set([...hidden, ...listed])].sort();
}

/** A group's tri-state over its listed rows. */
export function groupState(
  rows: readonly KindRow[],
  hidden: ReadonlySet<string>,
): GroupState {
  const off = rows.filter((r) => hidden.has(r.kind)).length;
  if (off === 0) return "all";
  return off === rows.length ? "none" : "some";
}

/** A group click: hides every listed row when all are shown, else shows them all. */
export function toggleGroup(
  rows: readonly KindRow[],
  hidden: readonly string[],
): string[] {
  const kinds = rows.map((r) => r.kind);
  return groupState(rows, new Set(hidden)) === "all"
    ? hideListed(hidden, kinds)
    : showListed(hidden, kinds);
}

/** The Kinds search: the label, the kind or the group label, ignoring case. */
export function matchesKind(
  row: KindRow,
  groupLabel: string,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return [row.label, row.kind, groupLabel].some((s) =>
    s.toLowerCase().includes(q),
  );
}

/** True while a listed namespace or a present kind is hidden (spec H58, H60). */
export function filtersActive(
  namespaces: readonly string[],
  hiddenNamespaces: ReadonlySet<string>,
  groups: readonly KindGroup[],
  hiddenKinds: ReadonlySet<string>,
): boolean {
  return (
    namespaces.some((ns) => hiddenNamespaces.has(ns)) ||
    groups.some((g) => g.kinds.some((k) => hiddenKinds.has(k.kind)))
  );
}
