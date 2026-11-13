import type { GraphNode } from "../../ipc/generated/GraphNode";
import type { GraphRel } from "../../ipc/generated/GraphRel";
import { USE } from "./layout/constants";
import { layoutCluster } from "./layout/force";
import { boxText, cellW, leafSize } from "./layout/geometry";
import {
  boxRects,
  type Flow,
  type GroupTree,
  groupedEdges,
  groupTree,
  layoutGrouped,
  type Point,
  type Positions,
  type Rect,
  ROOT,
} from "./layout/grouped";
import { layoutClusterLayered, layoutFocus } from "./layout/layered";
import { type MapModel, nodeOf } from "./model";

/** The layouts of spec E §7.1. Force is offered on the cluster map only. */
export type LayoutName = "grouped" | "layered" | "force";

export interface ArrangeOptions {
  layout: LayoutName;
  /** The cluster map, or an object map (page or drawer). */
  page: "cluster" | "object";
  flow: Flow;
  focusId: string;
}

/** The layout's positions for the drawn ids, before any move by hand. */
export function arrange(
  model: MapModel,
  ids: readonly string[],
  o: ArrangeOptions,
): Positions {
  if (o.layout === "grouped") {
    return layoutGrouped(model, ids, o.flow, o.focusId);
  }
  if (o.layout === "force") return layoutCluster(model, ids);
  return o.page === "cluster"
    ? layoutClusterLayered(model, ids)
    : layoutFocus(model, ids, o.flow === "v");
}

/** A node drawn as an icon with its name. */
export interface SceneIcon {
  id: string;
  node: GraphNode;
  x: number;
  y: number;
  size: number;
}

/** A Grouped box: an owner (with its node), a namespace, or the outside. */
export interface SceneBox {
  key: string;
  node: GraphNode | null;
  kind: string;
  namespace: string;
  rect: Rect;
  title: string;
  sub: string;
}

export type EdgeStyle = "own" | "net" | "use";

export interface SceneEdge {
  key: string;
  from: string;
  rel: GraphRel;
  to: string;
  /** The node ids the edge stands for: both ends, or a box and its Pods. */
  ids: string[];
  d: string;
  head: string;
  style: EdgeStyle;
  /** True when the two ends sit in different namespaces. */
  across: boolean;
}

/** A namespace's area in Layered and Force. */
export interface SceneHull {
  namespace: string;
  rect: Rect;
}

export interface Scene {
  icons: SceneIcon[];
  boxes: SceneBox[];
  edges: SceneEdge[];
  hulls: SceneHull[];
  extent: Rect;
  /** Where each drawn node is: an icon's centre, or an owner box's centre. */
  centres: Record<string, Point>;
  /** The Grouped containment, for moving a box with its contents. */
  tree: GroupTree | null;
}

const styleOf = (rel: GraphRel): EdgeStyle =>
  rel === "owns" ? "own" : USE.has(rel) ? "use" : "net";

const f = (n: number) => n.toFixed(1);

function rect(x0: number, y0: number, x1: number, y1: number): Rect {
  return { x0, y0, x1, y1, lab: 0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

function union(rects: Rect[]): Rect {
  if (!rects.length) return rect(0, 0, 0, 0);
  return rect(
    Math.min(...rects.map((r) => r.x0)),
    Math.min(...rects.map((r) => r.y0)),
    Math.max(...rects.map((r) => r.x1)),
    Math.max(...rects.map((r) => r.y1)),
  );
}

/** An S-curve along the levels of a Layered layout, or a straight line. */
function segment(a: Point, b: Point, curve: Flow | null): string {
  if (curve === "h" && Math.abs(b.x - a.x) > 1) {
    const m = (b.x - a.x) / 2;
    return `M${f(a.x)} ${f(a.y)} C${f(a.x + m)} ${f(a.y)} ${f(b.x - m)} ${f(b.y)} ${f(b.x)} ${f(b.y)}`;
  }
  if (curve === "v" && Math.abs(b.y - a.y) > 1) {
    const m = (b.y - a.y) / 2;
    return `M${f(a.x)} ${f(a.y)} C${f(a.x)} ${f(a.y + m)} ${f(b.x)} ${f(b.y - m)} ${f(b.x)} ${f(b.y)}`;
  }
  return `M${f(a.x)} ${f(a.y)} L${f(b.x)} ${f(b.y)}`;
}

/** What the canvas draws for the drawn ids at their current positions. */
export function buildScene(
  model: MapModel,
  ids: readonly string[],
  o: ArrangeOptions,
  pos: Positions,
): Scene {
  const icon = (id: string): SceneIcon => ({
    id,
    node: nodeOf(model, id),
    x: pos[id].x,
    y: pos[id].y,
    size: leafSize(id === o.focusId),
  });
  const cell = (s: SceneIcon) => {
    const w = cellW(s.node.name, s.id === o.focusId);
    return rect(
      s.x - w / 2,
      s.y - s.size / 2,
      s.x + w / 2,
      s.y + s.size / 2 + 28,
    );
  };

  if (o.layout === "grouped") {
    const tree = groupTree(model, ids);
    const { boxes: rects, extent } = boxRects(model, tree, pos, o.focusId);
    const icons = ids.filter((id) => !tree.groups[id]).map(icon);
    const boxes = Object.keys(rects)
      .filter((k) => k !== ROOT)
      .sort((a, b) => tree.depth[a] - tree.depth[b])
      .map((k): SceneBox => {
        const g = tree.groups[k];
        const text = boxText(model, g);
        return {
          key: k,
          node: g.id ? nodeOf(model, g.id) : null,
          kind: g.kind,
          namespace: g.namespace,
          rect: rects[k],
          title: text.title,
          sub: text.sub,
        };
      });
    const centres: Record<string, Point> = {};
    for (const s of icons) centres[s.id] = { x: s.x, y: s.y };
    for (const b of boxes) {
      if (b.node) centres[b.node.id] = { x: b.rect.cx, y: b.rect.cy };
    }
    const edges = groupedEdges(model, tree, pos, o.flow, o.focusId).map(
      (e): SceneEdge => ({
        key: `${e.from}>${e.rel}>${e.to}`,
        from: e.from,
        rel: e.rel,
        to: e.to,
        ids: e.ids,
        d: e.d,
        head: e.head,
        style: e.cls,
        across:
          nodeOf(model, e.from).namespace !== nodeOf(model, e.to).namespace,
      }),
    );
    return { icons, boxes, edges, hulls: [], extent, centres, tree };
  }

  const icons = ids.map(icon);
  const centres: Record<string, Point> = {};
  for (const s of icons) centres[s.id] = { x: s.x, y: s.y };
  const curve: Flow | null =
    o.layout === "layered"
      ? o.page === "object" && o.flow === "v"
        ? "v"
        : "h"
      : null;
  const drawn = new Set(ids);
  const edges = model.edges
    .filter((e) => drawn.has(e.from) && drawn.has(e.to))
    .map(
      (e): SceneEdge => ({
        key: `${e.from}>${e.rel}>${e.to}`,
        from: e.from,
        rel: e.rel,
        to: e.to,
        ids: [e.from, e.to],
        d: segment(centres[e.from], centres[e.to], curve),
        head: "",
        style: styleOf(e.rel),
        across:
          nodeOf(model, e.from).namespace !== nodeOf(model, e.to).namespace,
      }),
    );
  const byNamespace = new Map<string, Rect[]>();
  for (const s of icons) {
    if (s.node.namespace === "") continue;
    byNamespace.set(s.node.namespace, [
      ...(byNamespace.get(s.node.namespace) ?? []),
      cell(s),
    ]);
  }
  const hulls = [...byNamespace]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([namespace, cells]) => {
      const r = union(cells);
      return {
        namespace,
        rect: rect(r.x0 - 16, r.y0 - 32, r.x1 + 16, r.y1 + 12),
      };
    });
  const extent = union([...icons.map(cell), ...hulls.map((h) => h.rect)]);
  return { icons, boxes: [], edges, hulls, extent, centres, tree: null };
}
