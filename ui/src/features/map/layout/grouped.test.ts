import { describe, expect, it } from "vitest";
import {
  DEMO,
  demoGraph,
  drawnHiding,
  gedge,
  gnode,
  ownsCycle,
} from "../../../test/graph";
import { buildModel, type MapModel } from "../model";
import { leafSize } from "./geometry";
import {
  boxRects,
  EXTERNAL,
  footprint,
  groupedEdges,
  groupTree,
  layoutGrouped,
  type Positions,
  poly,
  type Rect,
  ROOT,
} from "./grouped";

function demoModel() {
  const { nodes, edges } = demoGraph();
  return buildModel(nodes, edges);
}

const inside = (inner: Rect, outer: Rect) =>
  inner.x0 >= outer.x0 - 0.01 &&
  inner.y0 >= outer.y0 - 0.01 &&
  inner.x1 <= outer.x1 + 0.01 &&
  inner.y1 <= outer.y1 + 0.01;

const overlap = (a: Rect, b: Rect) =>
  a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

function checkLayout(model: MapModel, ids: string[], pos: Positions) {
  const tree = groupTree(model, ids);
  const { boxes } = boxRects(model, tree, pos, "");
  for (const id of ids) {
    expect(pos[id], id).toBeDefined();
    expect(Number.isFinite(pos[id].x) && Number.isFinite(pos[id].y)).toBe(true);
  }
  for (const [key, group] of Object.entries(tree.groups)) {
    if (key === ROOT) continue;
    for (const kid of group.kids) {
      const r = tree.groups[kid] ? boxes[kid] : footprint(model, pos, kid, "");
      expect(inside(r, boxes[key]), `${kid} in ${key}`).toBe(true);
    }
  }
  // Owners are boxes; the other nodes are icons that must not overlap.
  const icons = ids.filter((id) => !tree.groups[id]);
  const cells = icons.map((id) => footprint(model, pos, id, ""));
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      expect(overlap(cells[i], cells[j]), `${icons[i]} and ${icons[j]}`).toBe(
        false,
      );
    }
  }
}

describe("groupTree", () => {
  it("puts each node in its nearest drawn owner, else its namespace", () => {
    const model = demoModel();
    const tree = groupTree(
      model,
      model.nodes.map((n) => n.id),
    );
    expect(tree.parentOf[DEMO.podA]).toBe(DEMO.replicaSet);
    expect(tree.parentOf[DEMO.replicaSet]).toBe(DEMO.deployment);
    expect(tree.parentOf[DEMO.deployment]).toBe("ns:shop");
    expect(tree.parentOf[DEMO.service]).toBe("ns:shop");
    expect(tree.parentOf[DEMO.ingressLb]).toBe(EXTERNAL);
    expect(tree.parentOf[DEMO.gatewayClass]).toBe(ROOT);
    expect(tree.groups[ROOT].kids[0]).toBe(EXTERNAL);
    expect(tree.leaves[DEMO.deployment]).toEqual([DEMO.podA, DEMO.podB]);
  });

  it("skips an owner that is not drawn", () => {
    const model = demoModel();
    const tree = groupTree(model, [DEMO.deployment, DEMO.podA]);
    expect(tree.parentOf[DEMO.podA]).toBe(DEMO.deployment);
  });
});

describe("layoutGrouped", () => {
  it("places every node in its box without overlaps, left to right", () => {
    const model = demoModel();
    const ids = model.nodes.map((n) => n.id);
    checkLayout(model, ids, layoutGrouped(model, ids, "h"));
  });

  it("places every node in its box without overlaps, top to bottom", () => {
    const model = demoModel();
    const ids = model.nodes.map((n) => n.id);
    const pos = layoutGrouped(model, ids, "v", DEMO.podA);
    for (const id of ids) expect(pos[id]).toBeDefined();
    checkLayout(model, ids, layoutGrouped(model, ids, "v"));
  });

  it("puts what is outside the cluster first along the flow", () => {
    const model = demoModel();
    const ids = model.nodes.map((n) => n.id);
    const pos = layoutGrouped(model, ids, "h");
    expect(pos[DEMO.ingressLb].x).toBeLessThan(pos[DEMO.ingress].x);
    expect(pos[DEMO.ingress].x).toBeLessThan(pos[DEMO.service].x);
    expect(pos[DEMO.service].x).toBeLessThan(pos[DEMO.podA].x);
    expect(pos[DEMO.podA].x).toBeLessThan(pos[DEMO.configMap].x);
  });

  it("is the same twice", () => {
    const model = demoModel();
    const ids = model.nodes.map((n) => n.id);
    expect(layoutGrouped(model, ids)).toEqual(layoutGrouped(model, ids));
  });
});

describe("groupedEdges", () => {
  it("draws one arrow to a box whose Pods all share a link, and no owns", () => {
    const model = demoModel();
    const ids = model.nodes.map((n) => n.id);
    const tree = groupTree(model, ids);
    const edges = groupedEdges(model, tree, layoutGrouped(model, ids), "h", "");
    const brief = edges.map((e) => `${e.from} ${e.rel} ${e.to}`);
    expect(brief).toContain(`${DEMO.service} selects ${DEMO.replicaSet}`);
    expect(brief).toContain(`${DEMO.replicaSet} mounts ${DEMO.configMap}`);
    expect(brief).toContain(`${DEMO.podA} claims ${DEMO.claim}`);
    expect(brief).toContain(`${DEMO.gateway} class ${DEMO.gatewayClass}`);
    expect(edges.some((e) => e.rel === "owns")).toBe(false);
    const selects = edges.find((e) => e.rel === "selects");
    expect(selects?.ids).toEqual([DEMO.service, DEMO.podA, DEMO.podB]);
    for (const e of edges) {
      expect(e.d).toMatch(/^M-?\d/);
      expect(e.head).toMatch(/Z$/);
    }
  });
});

describe("owners that own each other", () => {
  for (const size of [1, 2, 3]) {
    it(`draws a cycle of ${size} with every node placed`, () => {
      const { nodes, edges } = ownsCycle(size);
      const model = buildModel(nodes, edges);
      const ids = nodes.map((n) => n.id);
      const tree = groupTree(model, ids);
      for (const id of ids) {
        const seen = new Set<string>();
        for (let k = id; k !== ROOT; k = tree.parentOf[k]) {
          expect(seen.has(k), `${id} reaches the root`).toBe(false);
          seen.add(k);
        }
      }
      const pos = layoutGrouped(model, ids);
      checkLayout(model, ids, pos);
      expect(groupedEdges(model, tree, pos, "h", "")).toEqual([]);
    });
  }
});

describe("poly", () => {
  it("gives the point halfway along the line", () => {
    expect(
      poly([
        [0, 0],
        [10, 0],
      ]).mid,
    ).toEqual({ x: 5, y: 0 });
    expect(
      poly([
        [0, 0],
        [0, 10],
        [30, 10],
      ]).mid,
    ).toEqual({ x: 10, y: 10 });
  });
});

describe("bridged edges", () => {
  const f = (n: number) => n.toFixed(1);

  it("draws a bridged owns edge as a branch from the owner box's corner to each child", () => {
    const model = drawnHiding(["ReplicaSet"]);
    const ids = model.nodes.map((n) => n.id);
    const tree = groupTree(model, ids);
    const pos = layoutGrouped(model, ids);
    const owner = boxRects(model, tree, pos, "").boxes[DEMO.deployment];
    const branches = groupedEdges(model, tree, pos, "h", "").filter(
      (e) => e.cls === "own",
    );
    expect(branches.map((e) => [e.from, e.to, e.via])).toEqual([
      [DEMO.deployment, DEMO.podA, ["ReplicaSet"]],
      [DEMO.deployment, DEMO.podB, ["ReplicaSet"]],
    ]);
    const sx = owner.x0 + 14;
    const sy = owner.y0 + 40;
    for (const e of branches) {
      const p = pos[e.to];
      // Straight down, then right to the leaf's left edge at its centre.
      expect(e.d.startsWith(`M${f(sx)} ${f(sy)} L${f(sx)} `)).toBe(true);
      expect(
        e.head.startsWith(` M${f(p.x - leafSize(false) / 2)} ${f(p.y)} `),
      ).toBe(true);
      expect(e.mid).toEqual({ x: sx, y: sy + 9 });
    }
  });

  it("does not draw a branch to a child box that starts less than 16 px right of the start", () => {
    const nodes = [
      gnode("Deployment/n/d"),
      gnode("ReplicaSet/n/r"),
      gnode("Job/n/j"),
      gnode("Pod/n/p"),
    ];
    const edges = [
      gedge("Deployment/n/d", "owns", "ReplicaSet/n/r"),
      gedge("ReplicaSet/n/r", "owns", "Job/n/j"),
      gedge("Job/n/j", "owns", "Pod/n/p"),
    ];
    const model = drawnHiding(["ReplicaSet"], { nodes, edges });
    const ids = model.nodes.map((n) => n.id);
    const tree = groupTree(model, ids);
    expect(tree.parentOf["Job/n/j"]).toBe("Deployment/n/d");
    expect(
      groupedEdges(model, tree, layoutGrouped(model, ids), "h", "").filter(
        (e) => e.cls === "own",
      ),
    ).toEqual([]);
  });

  it("a merged arrow carries via only when every edge it stands for is a bridge", () => {
    const model = drawnHiding(["Service"]);
    const ids = model.nodes.map((n) => n.id);
    const tree = groupTree(model, ids);
    const edges = groupedEdges(model, tree, layoutGrouped(model, ids), "h", "");
    const fromIngress = edges.find(
      (e) => e.from === DEMO.ingress && e.rel === "selects",
    );
    expect(fromIngress?.to).toBe(DEMO.replicaSet);
    expect(fromIngress?.via).toEqual(["Service"]);
    const mounts = edges.find(
      (e) => e.rel === "mounts" && e.to === DEMO.configMap,
    );
    expect(mounts?.via).toBeUndefined();
  });
});
