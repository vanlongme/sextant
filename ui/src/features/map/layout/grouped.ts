import type { GraphRel } from "../../../ipc/generated/GraphRel";
import { type MapModel, nodeOf } from "../model";
import { BOX, FLOW, GAP, HEAD, LABEL_ROOM, PAD, USE } from "./constants";
import { boxText, cellW, headW, leafSize } from "./geometry";

/** `h` runs the flow left to right; `v` runs it top to bottom for narrow panels. */
export type Flow = "h" | "v";

export interface Point {
  x: number;
  y: number;
}

/** Node centres, and for boxes their top-left corner, by node id or box key. */
export type Positions = Record<string, Point>;

/** A Grouped box: an owner (keyed by its node id), a namespace, the outside, or the root. */
export interface Group {
  key: string;
  /** The owner's node id; empty for the other boxes. */
  id: string;
  kind: string;
  name: string;
  namespace: string;
  kids: string[];
}

export interface GroupTree {
  groups: Record<string, Group>;
  /** The box key holding each node id and each box key. */
  parentOf: Record<string, string>;
  /** The node ids under each box, at any depth. */
  leaves: Record<string, string[]>;
  depth: Record<string, number>;
}

/** The root box's key, and the key of the box of load balancers. */
export const ROOT = "";
export const EXTERNAL = "ext";
const namespaceKey = (namespace: string) => `ns:${namespace}`;

function ownerOf(model: MapModel, id: string): string | null {
  return model.incoming.get(id)?.find((e) => e.rel === "owns")?.from ?? null;
}

/**
 * Containment for the Grouped layout: a node sits in its nearest drawn owner's box,
 * else in its namespace's box; load balancers sit in the outside box, other
 * cluster-scoped nodes at the root. Kubernetes does not forbid owner references that
 * form a cycle: every walk stops at the first repeat, and a node whose box would hold
 * it back sits in its namespace's box instead, so the tree never has a cycle.
 */
export function groupTree(model: MapModel, ids: readonly string[]): GroupTree {
  const groups: Record<string, Group> = {
    [ROOT]: {
      key: ROOT,
      id: "",
      kind: "Root",
      name: "",
      namespace: "",
      kids: [],
    },
  };
  const parentOf: Record<string, string> = {};
  const holder = (id: string): string => {
    const node = nodeOf(model, id);
    if (node.kind === "LoadBalancer") {
      if (!groups[EXTERNAL]) {
        groups[EXTERNAL] = {
          key: EXTERNAL,
          id: "",
          kind: "External",
          name: "Outside the cluster",
          namespace: "",
          kids: [],
        };
        parentOf[EXTERNAL] = ROOT;
      }
      return EXTERNAL;
    }
    const visited = new Set([id]);
    for (
      let a = ownerOf(model, id);
      a !== null && !visited.has(a);
      a = ownerOf(model, a)
    ) {
      if (groups[a]) return a;
      visited.add(a);
    }
    return outerBox(id);
  };
  // The namespace's box, or the root for a cluster-scoped node.
  const outerBox = (id: string): string => {
    const node = nodeOf(model, id);
    if (node.namespace === "") return ROOT;
    const key = namespaceKey(node.namespace);
    if (!groups[key]) {
      groups[key] = {
        key,
        id: "",
        kind: "Namespace",
        name: node.namespace,
        namespace: node.namespace,
        kids: [],
      };
      parentOf[key] = ROOT;
    }
    return key;
  };
  for (const id of ids) {
    const node = nodeOf(model, id);
    if (BOX.has(node.kind)) {
      groups[id] = {
        key: id,
        id,
        kind: node.kind,
        name: node.name,
        namespace: node.namespace,
        kids: [],
      };
    }
  }
  for (const id of ids) parentOf[id] = holder(id);
  // Owners that own each other: the box whose parent is already on the path moves to its
  // namespace's box, which breaks the cycle at the first repeated ancestor.
  for (const id of ids) {
    const path = [id];
    for (let p = parentOf[id]; groups[p]?.id; p = parentOf[p]) {
      if (path.includes(p)) {
        const last = path[path.length - 1];
        parentOf[last] = outerBox(last);
        break;
      }
      path.push(p);
    }
  }

  const index = new Map(model.nodes.map((n, i) => [n.id, i]));
  const namespaces = [
    ...new Set(Object.values(groups).map((g) => g.namespace)),
  ].sort();
  const order = (k: string) =>
    k === EXTERNAL
      ? -1
      : (index.get(k) ??
        10000 + namespaces.indexOf(groups[k]?.namespace ?? ""));
  for (const k of Object.keys(parentOf).sort((a, b) => order(a) - order(b))) {
    groups[parentOf[k]].kids.push(k);
  }
  const leaves: Record<string, string[]> = {};
  const depth: Record<string, number> = {};
  const walk = (k: string, d: number) => {
    depth[k] = d;
    leaves[k] = [];
    for (const c of groups[k].kids) {
      if (groups[c]) {
        walk(c, d + 1);
        leaves[k].push(...leaves[c]);
      } else {
        leaves[k].push(c);
      }
    }
  };
  walk(ROOT, 0);
  return { groups, parentOf, leaves, depth };
}

/**
 * Where a link to `pod` attaches, given every Pod on that side of the link: the Pod's
 * own box when all its Pods share the link, else the Pod itself.
 */
export function podEnd(
  model: MapModel,
  tree: GroupTree,
  pod: string,
  pods: readonly string[],
  other: string | null,
): string {
  const box = tree.parentOf[pod];
  const group = box === undefined ? undefined : tree.groups[box];
  if (
    !group ||
    group.kind === "Namespace" ||
    group.kind === "Root" ||
    (other !== null && tree.leaves[box].includes(other))
  ) {
    return pod;
  }
  const mine = tree.leaves[box].filter((l) => nodeOf(model, l).kind === "Pod");
  return mine.length > 1 && mine.every((p) => pods.includes(p)) ? box : pod;
}

function linkedTo(
  model: MapModel,
  id: string,
  rels: ReadonlySet<GraphRel>,
  dir: "in" | "out",
): string[] {
  const list = (dir === "out" ? model.outgoing : model.incoming).get(id) ?? [];
  return list
    .filter((e) => rels.has(e.rel))
    .map((e) => (dir === "out" ? e.to : e.from));
}

const SELECTS: ReadonlySet<GraphRel> = new Set(["selects"]);
const ROUTES: ReadonlySet<GraphRel> = new Set(["routes"]);

/** A laid-out block: size, and points relative to its top-left corner. */
interface Block {
  w: number;
  h: number;
  pts: Positions;
}

const EMPTY: Block = { w: 0, h: 0, pts: {} };

function put(into: Positions, block: Block, dx: number, dy: number): void {
  for (const k in block.pts) {
    into[k] = { x: block.pts[k].x + dx, y: block.pts[k].y + dy };
  }
}

const mean = (vals: (number | null)[]): number | null => {
  const v = vals.filter((x): x is number => x !== null);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
};

/** Columns inside a namespace box: routes, Services, workloads, config. */
const ROLE: Readonly<Record<string, number>> = {
  Gateway: 0,
  Ingress: 0,
  HTTPRoute: 0,
  Service: 1,
  ConfigMap: 3,
  Secret: 3,
  ServiceAccount: 3,
  PersistentVolumeClaim: 3,
};

interface Item {
  k: string;
  i: number;
  b: Block;
  d: number | null;
  loose: boolean;
  o: number;
  c: number;
  mid: number;
}

/**
 * Positions for the Grouped layout (spec E §7.1): node centres, and the top-left corner of
 * each box, which is what an empty box is drawn from.
 */
export function layoutGrouped(
  model: MapModel,
  ids: readonly string[],
  flow: Flow = "h",
  focusId = "",
): Positions {
  const tree = groupTree(model, ids);
  const H = flow !== "v";
  const isBox = (k: string) => tree.groups[k] !== undefined;
  const leaf = (id: string): Block => {
    const s = leafSize(id === focusId);
    const w = cellW(nodeOf(model, id).name, id === focusId);
    return { w, h: s + LABEL_ROOM, pts: { [id]: { x: w / 2, y: s / 2 } } };
  };
  const mainOf = (b: Block) => (H ? b.w : b.h);
  const crossOf = (b: Block) => (H ? b.h : b.w);
  const at = (m: number, c: number): [number, number] => (H ? [m, c] : [c, m]);

  // Blocks along the cross axis, centred on the main axis, wrapping after `per`.
  const stack = (
    blocks: Block[],
    per = Number.POSITIVE_INFINITY,
    gap = GAP,
  ): Block => {
    if (!blocks.length) return EMPTY;
    const lines: Block[][] = [];
    blocks.forEach((b, i) => {
      if (i % per === 0) lines.push([]);
      lines[lines.length - 1].push(b);
    });
    const pts: Positions = {};
    let m = 0;
    let cMax = 0;
    for (const line of lines) {
      const lm = Math.max(...line.map(mainOf));
      let c = 0;
      for (const b of line) {
        const [x, y] = at(m + (lm - mainOf(b)) / 2, c);
        put(pts, b, x, y);
        c += crossOf(b) + gap;
      }
      cMax = Math.max(cMax, c - gap);
      m += lm + gap;
    }
    const [w, h] = at(m - gap, cMax);
    return { w, h, pts };
  };

  // Rows of boxes, wrapping near a square overall shape (h), or one column (v). The gap
  // leaves room for links between namespaces, which run along it.
  const shelf = (blocks: Block[], gap = 44): Block => {
    if (!blocks.length) return EMPTY;
    const area = blocks.reduce((s, b) => s + (b.w + gap) * (b.h + gap), 0);
    const widest = Math.max(...blocks.map((b) => b.w));
    const limit = H ? Math.max(widest, Math.sqrt(area) * 1.2) : widest;
    const pts: Positions = {};
    let x = 0;
    let y = 0;
    let rowH = 0;
    let w = 0;
    for (const b of blocks) {
      if (x > 0 && x + b.w > limit) {
        x = 0;
        y += rowH + gap;
        rowH = 0;
      }
      put(pts, b, x, y);
      x += b.w + gap;
      rowH = Math.max(rowH, b.h);
      w = Math.max(w, x - gap);
    }
    return { w, h: y + rowH, pts };
  };

  // Inside a namespace: columns for routes, Services, workloads and config. Each column
  // but the workloads lines its items up with what they link to, so most links run straight.
  const namespace = (kids: string[]): Block => {
    const cols: string[][] = [[], [], [], []];
    for (const k of kids) {
      cols[isBox(k) ? 2 : (ROLE[nodeOf(model, k).kind] ?? 2)].push(k);
    }
    const work = stack(cols[2].map(block), Number.POSITIVE_INFINITY, GAP + 8);
    const centre = (k: string): number | null => {
      const p = work.pts[k];
      return p ? (H ? p.y : p.x) : null;
    };
    const offset = (k: string, b: Block) =>
      isBox(k) ? crossOf(b) / 2 : H ? b.pts[k].y : b.pts[k].x;
    // Items linked to single Pods take their spot first; items linked to a whole box then
    // take the free gap nearest to where they want to be.
    const aligned = (
      keys: string[],
      want: (k: string) => number | null,
      loose: (k: string) => boolean,
    ) => {
      if (!keys.length) return null;
      const items: Item[] = keys.map((k, i) => {
        const b = block(k);
        return {
          k,
          i,
          b,
          d: want(k),
          loose: loose(k),
          o: offset(k, b),
          c: 0,
          mid: 0,
        };
      });
      const placed: Item[] = [];
      let end = Number.NEGATIVE_INFINITY;
      const fixed = items
        .filter((x) => !x.loose && x.d !== null)
        .sort((p, q) => (p.d ?? 0) - (q.d ?? 0) || p.i - q.i);
      for (const it of fixed) {
        it.c = Math.max((it.d ?? 0) - it.o, end + GAP);
        end = it.c + crossOf(it.b);
        placed.push(it);
      }
      const rest = items
        .filter((x) => !placed.includes(x))
        .sort(
          (p, q) =>
            (p.d ?? Number.POSITIVE_INFINITY) -
              (q.d ?? Number.POSITIVE_INFINITY) || p.i - q.i,
        );
      for (const it of rest) {
        const size = crossOf(it.b);
        const target = it.d === null ? null : it.d - it.o;
        placed.sort((p, q) => p.c - q.c);
        const last = placed.length
          ? Math.max(...placed.map((p) => p.c + crossOf(p.b))) + GAP
          : 0;
        const options = [target === null ? last : Math.max(target, last)];
        if (target !== null && placed.length) {
          options.push(Math.min(target, placed[0].c - GAP - size));
        }
        for (let j = 0; target !== null && j + 1 < placed.length; j++) {
          const lo = placed[j].c + crossOf(placed[j].b) + GAP;
          const hi = placed[j + 1].c - GAP - size;
          if (hi >= lo) options.push(Math.min(hi, Math.max(lo, target)));
        }
        it.c =
          target === null || !placed.length
            ? options[0]
            : options.reduce((a, b) =>
                Math.abs(b - target) < Math.abs(a - target) ? b : a,
              );
        placed.push(it);
      }
      for (const it of items) it.mid = it.c + it.o;
      return { lm: Math.max(...items.map((it) => mainOf(it.b))), items };
    };
    const visiblePods = (list: string[]) => list.filter((p) => p in work.pts);
    const boxWide = (pods: string[], other: string) =>
      pods.length > 0 &&
      pods.every((p) => podEnd(model, tree, p, pods, other) !== p);
    const placed: (ReturnType<typeof aligned> | undefined)[] = [];
    placed[1] = aligned(
      cols[1],
      (k) => mean(linkedTo(model, k, SELECTS, "out").map(centre)),
      (k) => boxWide(visiblePods(linkedTo(model, k, SELECTS, "out")), k),
    );
    const svc = new Map((placed[1]?.items ?? []).map((it) => [it.k, it.mid]));
    placed[0] = aligned(
      cols[0],
      (k) =>
        mean(linkedTo(model, k, ROUTES, "out").map((s) => svc.get(s) ?? null)),
      () => false,
    );
    placed[3] = aligned(
      cols[3],
      (k) => mean(linkedTo(model, k, USE, "in").map(centre)),
      (k) => boxWide(visiblePods(linkedTo(model, k, USE, "in")), k),
    );
    const raw: Positions = {};
    let m = 0;
    let cMin = Number.POSITIVE_INFINITY;
    let cMax = Number.NEGATIVE_INFINITY;
    const place = (b: Block, mm: number, cc: number) => {
      const [x, y] = at(mm, cc);
      put(raw, b, x, y);
      cMin = Math.min(cMin, cc);
      cMax = Math.max(cMax, cc + crossOf(b));
    };
    for (const r of [0, 1, 2, 3]) {
      if (r === 2) {
        if (cols[2].length) {
          place(work, m, 0);
          m += mainOf(work) + FLOW;
        }
        continue;
      }
      const col = placed[r];
      if (!col) continue;
      for (const it of col.items)
        place(it.b, m + (col.lm - mainOf(it.b)) / 2, it.c);
      m += col.lm + FLOW;
    }
    if (m === 0) return EMPTY;
    const pts: Positions = {};
    const [sx, sy] = at(0, -cMin);
    put(pts, { w: 0, h: 0, pts: raw }, sx, sy);
    const [w, h] = at(m - FLOW, cMax - cMin);
    return { w, h, pts };
  };

  // Pods that each use an item no other Pod uses (a StatefulSet's volume claims) stay in
  // one line instead of wrapping, so every item can sit level with its own Pod.
  const shown = new Set(ids);
  const own = (p: string) =>
    linkedTo(model, p, USE, "out").some(
      (x) => shown.has(x) && linkedTo(model, x, USE, "in").length === 1,
    );
  const ownLine = (kids: string[]) =>
    kids.length > 1 &&
    kids.length <= (H ? 12 : 6) &&
    kids.every((p) => !isBox(p) && own(p));

  function block(k: string): Block {
    const g = tree.groups[k];
    if (!g) return leaf(k);
    const kidBlocks = () => g.kids.map(block);
    // What is outside the cluster comes first along the flow: left of everything, or above.
    if (k === ROOT && g.kids.includes(EXTERNAL)) {
      const e = block(EXTERNAL);
      const main = shelf(g.kids.filter((c) => c !== EXTERNAL).map(block));
      const pts: Positions = {};
      put(pts, e, 0, 0);
      if (H) {
        put(pts, main, e.w + 72, 0);
        return { w: e.w + 72 + main.w, h: Math.max(e.h, main.h), pts };
      }
      put(pts, main, 0, e.h + 72);
      return { w: Math.max(e.w, main.w), h: e.h + 72 + main.h, pts };
    }
    const content =
      g.kind === "Root"
        ? shelf(kidBlocks())
        : g.kind === "Namespace"
          ? namespace(g.kids)
          : g.kind === "Deployment" ||
              g.kind === "CronJob" ||
              g.kind === "External"
            ? stack(kidBlocks())
            : stack(
                kidBlocks(),
                ownLine(g.kids) ? Number.POSITIVE_INFINITY : H ? 4 : 3,
              );
    if (k === ROOT) return content;
    const pts: Positions = { [k]: { x: 0, y: 0 } };
    put(pts, content, PAD, HEAD);
    return {
      w: Math.max(headW(boxText(model, g)), content.w + 2 * PAD),
      h: HEAD + (g.kids.length ? content.h + PAD : 24),
      pts,
    };
  }
  return block(ROOT).pts;
}

/** A box or a node's rectangle; `lab` is the room its name takes below it. */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  lab: number;
  cx: number;
  cy: number;
}

/** What a node takes: its cell's width, its icon and the name under it. */
export function footprint(
  model: MapModel,
  pos: Positions,
  id: string,
  focusId: string,
): Rect {
  const p = pos[id];
  const s = leafSize(id === focusId);
  const w = cellW(nodeOf(model, id).name, id === focusId);
  return rect(
    p.x - w / 2,
    p.y - s / 2,
    p.x + w / 2,
    p.y + s / 2 + LABEL_ROOM,
    0,
  );
}

function rect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  lab: number,
): Rect {
  return { x0, y0, x1, y1, lab, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

/**
 * Each box's rectangle around its contents at their current positions (moved by hand or
 * not), and the extent of the whole drawing.
 */
export function boxRects(
  model: MapModel,
  tree: GroupTree,
  pos: Positions,
  focusId: string,
): { boxes: Record<string, Rect>; extent: Rect } {
  const boxes: Record<string, Rect> = {};
  const rectOf = (k: string): Rect => {
    const g = tree.groups[k];
    let x0 = Number.POSITIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let y1 = Number.NEGATIVE_INFINITY;
    for (const c of g.kids) {
      const r = tree.groups[c] ? rectOf(c) : footprint(model, pos, c, focusId);
      x0 = Math.min(x0, r.x0);
      y0 = Math.min(y0, r.y0);
      x1 = Math.max(x1, r.x1);
      y1 = Math.max(y1, r.y1);
    }
    const a = pos[k] ?? { x: 0, y: 0 };
    const head = headW(boxText(model, g));
    const r = Number.isFinite(x0)
      ? rect(
          x0 - PAD,
          y0 - HEAD,
          Math.max(x1 + PAD, x0 - PAD + head),
          y1 + PAD,
          0,
        )
      : rect(a.x, a.y, a.x + head, a.y + HEAD + 24, 0);
    boxes[k] = r;
    return r;
  };
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const c of tree.groups[ROOT].kids) {
    const r = tree.groups[c] ? rectOf(c) : footprint(model, pos, c, focusId);
    x0 = Math.min(x0, r.x0);
    y0 = Math.min(y0, r.y0);
    x1 = Math.max(x1, r.x1);
    y1 = Math.max(y1, r.y1);
  }
  const extent = Number.isFinite(x0)
    ? rect(x0, y0, x1, y1, 0)
    : rect(0, 0, 0, 0, 0);
  return { boxes, extent };
}

/** The class an edge is drawn with; `own` is a bridged owns branch (spec H64). */
export type EdgeClass = "net" | "use" | "own";

/** A drawn Grouped edge, with the ids it stands for and its path and arrow head. */
export interface GroupedEdge {
  cls: EdgeClass;
  rel: GraphRel;
  from: string;
  to: string;
  ids: string[];
  d: string;
  head: string;
  /** Where a bridge's via mark sits. */
  mid: Point;
  /** The hidden kinds a bridge passes through. */
  via?: string[];
}

const f = (n: number) => n.toFixed(1);
const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

/** The point halfway along a polyline, bends taken as corners. */
function midpoint(pts: [number, number][]): Point {
  const lengths = pts
    .slice(1)
    .map(([x, y], i) => Math.hypot(x - pts[i][0], y - pts[i][1]));
  let left = lengths.reduce((a, b) => a + b, 0) / 2;
  for (let i = 0; i < lengths.length; i++) {
    if (left <= lengths[i] || i === lengths.length - 1) {
      const t = lengths[i] === 0 ? 0 : Math.min(1, left / lengths[i]);
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[i + 1];
      return { x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t };
    }
    left -= lengths[i];
  }
  return { x: pts[0][0], y: pts[0][1] };
}

/** An orthogonal polyline with rounded bends, ending in an arrow head. */
export function poly(pts: [number, number][]): {
  d: string;
  head: string;
  mid: Point;
} {
  const n = pts.length;
  const [xe, ye] = pts[n - 1];
  const [xa, ya] = pts[n - 2];
  const len = Math.max(Math.abs(xe - xa), Math.abs(ye - ya)) || 1;
  const ux = (xe - xa) / len;
  const uy = (ye - ya) / len;
  const bx = xe - ux * 8;
  const by = ye - uy * 8;
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 1; i < n - 1; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    const toward = (tx: number, ty: number): [number, number] => {
      const l = Math.max(Math.abs(tx - x1), Math.abs(ty - y1)) || 1;
      const r = Math.min(8, l / 2);
      return [x1 + ((tx - x1) / l) * r, y1 + ((ty - y1) / l) * r];
    };
    const a = toward(x0, y0);
    const b = toward(x2, y2);
    d += ` L${f(a[0])} ${f(a[1])} Q${f(x1)} ${f(y1)} ${f(b[0])} ${f(b[1])}`;
  }
  d += ` L${f(bx)} ${f(by)}`;
  const head = ` M${f(xe)} ${f(ye)} L${f(bx - uy * 4.5)} ${f(by + ux * 4.5)} L${f(bx + uy * 4.5)} ${f(by - ux * 4.5)} Z`;
  return { d, head, mid: midpoint(pts) };
}

/**
 * The Grouped edges between the drawn nodes (spec E §8.1, H64): a real `owns` is the box
 * nesting and is not drawn, a bridged one is a branch in its owner's box; a link to every
 * Pod of a box becomes one arrow to the box. Each other edge runs orthogonally between the
 * edges of its ends, and between two namespace boxes through the gap between them.
 */
export function groupedEdges(
  model: MapModel,
  tree: GroupTree,
  pos: Positions,
  flow: Flow,
  focusId: string,
): GroupedEdge[] {
  const { boxes } = boxRects(model, tree, pos, focusId);
  const shown = new Set(
    Object.keys(tree.parentOf).filter((k) => !tree.groups[k]),
  );
  const all = model.edges.filter((e) => shown.has(e.from) && shown.has(e.to));
  const drawn: Omit<GroupedEdge, "d" | "head" | "mid">[] = [];
  const fan = (
    cls: EdgeClass,
    list: typeof all,
    hub: (e: (typeof all)[number]) => string,
    spoke: (e: (typeof all)[number]) => string,
    hubFirst: boolean,
  ) => {
    const byHub = new Map<string, typeof all>();
    for (const e of list) byHub.set(hub(e), [...(byHub.get(hub(e)) ?? []), e]);
    for (const [h, es] of byHub) {
      const many = [...new Set(es.map(spoke))];
      const ends = new Map<
        string,
        { rel: GraphRel; members: string[]; via: string[] | null }
      >();
      for (const e of es) {
        const s = spoke(e);
        const end =
          nodeOf(model, s).kind === "Pod" ? podEnd(model, tree, s, many, h) : s;
        const entry = ends.get(end) ?? { rel: e.rel, members: [], via: [] };
        if (!entry.members.includes(s)) entry.members.push(s);
        // A merged arrow is a bridge only when every edge it stands for is one.
        if (!e.via) {
          entry.via = null;
        } else if (entry.via) {
          for (const kind of e.via) {
            if (!entry.via.includes(kind)) entry.via.push(kind);
          }
        }
        ends.set(end, entry);
      }
      for (const [end, { rel, members, via }] of ends) {
        drawn.push({
          cls,
          rel,
          from: hubFirst ? h : end,
          to: hubFirst ? end : h,
          ids: [h, ...members],
          ...(via ? { via } : {}),
        });
      }
    }
  };
  fan(
    "net",
    all.filter((e) => e.rel === "routes"),
    (e) => e.from,
    (e) => e.to,
    true,
  );
  fan(
    "net",
    all.filter((e) => e.rel === "selects"),
    (e) => e.from,
    (e) => e.to,
    true,
  );
  for (const rel of USE) {
    fan(
      "use",
      all.filter((e) => e.rel === rel),
      (e) => e.to,
      (e) => e.from,
      false,
    );
  }

  const leafRect = (id: string): Rect => {
    const p = pos[id];
    const s = leafSize(id === focusId);
    return rect(p.x - s / 2, p.y - s / 2, p.x + s / 2, p.y + s / 2, 22);
  };
  const rectFor = (k: string) => (tree.groups[k] ? boxes[k] : leafRect(k));
  // Leave and enter through the side the link crosses; straight when the two overlap,
  // else one elbow halfway.
  const route = (a: Rect, b: Rect) => {
    const gx = Math.max(b.x0 - a.x1, a.x0 - b.x1);
    const gy = Math.max(b.y0 - a.y1 - a.lab, a.y0 - b.y1 - b.lab);
    const across =
      flow === "v" ? gy <= 14 && gx > 14 : gx > 14 || (gy <= 14 && gx > 0);
    if (across) {
      const right = b.x0 >= a.x1;
      const sx = right ? a.x1 : a.x0;
      const ex = right ? b.x0 - 1 : b.x1 + 1;
      const lo = Math.max(a.y0, b.y0);
      const hi = Math.min(a.y1, b.y1);
      if (hi - lo >= 10) {
        const y = (lo + hi) / 2;
        return poly([
          [sx, y],
          [ex, y],
        ]);
      }
      const ya = a.lab ? a.cy : clamp(b.cy, a.y0 + 18, a.y1 - 18);
      const yb = b.lab ? b.cy : clamp(a.cy, b.y0 + 18, b.y1 - 18);
      const xm = (sx + ex) / 2;
      return poly([
        [sx, ya],
        [xm, ya],
        [xm, yb],
        [ex, yb],
      ]);
    }
    if (gy > 0) {
      const down = b.y0 >= a.y1 + a.lab;
      const sy = down ? a.y1 + a.lab : a.y0;
      const ey = down ? b.y0 - 1 : b.y1 + b.lab + 1;
      const lo = Math.max(a.x0, b.x0);
      const hi = Math.min(a.x1, b.x1);
      if (hi - lo >= 10) {
        const x = (lo + hi) / 2;
        return poly([
          [x, sy],
          [x, ey],
        ]);
      }
      const xa = a.lab ? a.cx : clamp(b.cx, a.x0 + 18, a.x1 - 18);
      const xb = b.lab ? b.cx : clamp(a.cx, b.x0 + 18, b.x1 - 18);
      const ym = (sy + ey) / 2;
      return poly([
        [xa, sy],
        [xa, ym],
        [xb, ym],
        [xb, ey],
      ]);
    }
    return poly([
      [a.cx, a.cy],
      [b.cx, b.cy],
    ]);
  };
  // Links between namespaces run their long leg in the gap between the two boxes that hold
  // the ends; parallel links get lanes.
  const lanes = new Map<string, number>();
  const lane = (key: string) => {
    const n = lanes.get(key) ?? 0;
    lanes.set(key, n + 1);
    return (n % 2 ? 1 : -1) * Math.ceil(n / 2) * 7;
  };
  const gutter = (a: Rect, b: Rect, A: Rect, B: Rect) => {
    const hg = Math.max(B.x0 - A.x1, A.x0 - B.x1);
    const vg = Math.max(B.y0 - A.y1, A.y0 - B.y1);
    if (vg > 0 && (vg >= hg || flow === "v")) {
      const down = B.y0 >= A.y1;
      const mid = down ? (A.y1 + B.y0) / 2 : (B.y1 + A.y0) / 2;
      const y = mid + lane(`y${Math.round(mid)}`);
      const sy = down ? a.y1 + a.lab : a.y0;
      const ey = down ? b.y0 - 1 : b.y1 + b.lab + 1;
      const xa = a.lab ? a.cx : clamp(b.cx, a.x0 + 18, a.x1 - 18);
      const xb = b.lab ? b.cx : clamp(a.cx, b.x0 + 18, b.x1 - 18);
      return poly([
        [xa, sy],
        [xa, y],
        [xb, y],
        [xb, ey],
      ]);
    }
    if (hg > 0) {
      const right = B.x0 >= A.x1;
      const mid = right ? (A.x1 + B.x0) / 2 : (B.x1 + A.x0) / 2;
      const x = mid + lane(`x${Math.round(mid)}`);
      const sx = right ? a.x1 : a.x0;
      const ex = right ? b.x0 - 1 : b.x1 + 1;
      const ya = a.lab ? a.cy : clamp(b.cy, a.y0 + 18, a.y1 - 18);
      const yb = b.lab ? b.cy : clamp(a.cy, b.y0 + 18, b.y1 - 18);
      return poly([
        [sx, ya],
        [x, ya],
        [x, yb],
        [ex, yb],
      ]);
    }
    return route(a, b);
  };
  // The boxes from a node up to the root; `groupTree` never makes a cycle, and the walk
  // stops at a repeat all the same.
  const chain = (k: string) => {
    const out = [k];
    for (
      let p: string | undefined = tree.parentOf[k];
      p !== undefined && !out.includes(p);
      p = p === ROOT ? undefined : tree.parentOf[p]
    ) {
      out.push(p);
    }
    return out;
  };
  const routed = drawn.map((e): GroupedEdge => {
    const ca = chain(e.from);
    const cb = chain(e.to);
    const inB = new Set(cb);
    const i = ca.findIndex((k) => inB.has(k));
    const common = tree.groups[ca[i]];
    const A = ca[i - 1];
    const B = cb[cb.indexOf(ca[i]) - 1];
    const path =
      common?.kind === "Root" &&
      i >= 1 &&
      A !== undefined &&
      B !== undefined &&
      A !== B
        ? gutter(rectFor(e.from), rectFor(e.to), rectFor(A), rectFor(B))
        : route(rectFor(e.from), rectFor(e.to));
    return { ...e, ...path };
  });
  // A bridged owns edge is a dashed branch in its owner's box: down from under the
  // box's icon, then right to the child (spec H64).
  const branches: GroupedEdge[] = [];
  for (const e of model.edges) {
    if (e.rel !== "owns" || !e.via) continue;
    if (
      tree.parentOf[e.from] === undefined ||
      tree.parentOf[e.to] === undefined
    )
      continue;
    const owner = boxes[e.from];
    if (!owner || tree.parentOf[e.to] !== e.from) {
      branches.push({
        cls: "own",
        rel: e.rel,
        from: e.from,
        to: e.to,
        ids: [e.from, e.to],
        via: e.via,
        ...route(rectFor(e.from), rectFor(e.to)),
      });
      continue;
    }
    const sx = owner.x0 + 14;
    const sy = owner.y0 + 40;
    const box = tree.groups[e.to] ? boxes[e.to] : undefined;
    const ex = box ? box.x0 : leafRect(e.to).x0;
    const ey = box ? box.y0 + 23 : pos[e.to].y;
    if (ex - sx < 16) continue;
    branches.push({
      cls: "own",
      rel: e.rel,
      from: e.from,
      to: e.to,
      ids: [e.from, e.to],
      via: e.via,
      ...poly([
        [sx, sy],
        [sx, ey],
        [ex, ey],
      ]),
      mid: { x: sx, y: sy + 9 },
    });
  }
  return [...routed, ...branches];
}
