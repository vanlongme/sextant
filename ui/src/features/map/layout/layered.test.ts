import { describe, expect, it } from "vitest";
import { DEMO, demoGraph, ownsCycle } from "../../../test/graph";
import { buildModel, type MapModel } from "../model";
import { cellW, leafSize } from "./geometry";
import type { Positions } from "./grouped";
import { layoutClusterLayered, layoutFocus, ranks } from "./layered";
import { neighborhood } from "./neighborhood";

function demoModel() {
  const { nodes, edges } = demoGraph();
  return buildModel(nodes, edges);
}

/** Each icon with its name under it, as a rectangle around its centre. */
function cells(model: MapModel, ids: string[], pos: Positions) {
  return ids.map((id) => {
    const w = cellW(model.byId.get(id)?.name ?? "", false);
    const s = leafSize(false);
    const p = pos[id];
    return {
      id,
      x0: p.x - w / 2,
      x1: p.x + w / 2,
      y0: p.y - s / 2,
      y1: p.y + s / 2 + 28,
    };
  });
}

function expectPlacedApart(model: MapModel, ids: string[], pos: Positions) {
  for (const id of ids) {
    expect(Number.isFinite(pos[id]?.x) && Number.isFinite(pos[id]?.y), id).toBe(
      true,
    );
  }
  const list = cells(model, ids, pos);
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      const hit = a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
      expect(hit, `${a.id} and ${b.id}`).toBe(false);
    }
  }
}

describe("ranks", () => {
  it("puts the way in first and config last", () => {
    const model = demoModel();
    const rank = ranks(model, neighborhood(model, DEMO.podA, 2));
    expect(rank[DEMO.ingressLb]).toBe(0);
    expect(rank[DEMO.gatewayLb]).toBe(0);
    expect(rank[DEMO.ingress]).toBeLessThan(rank[DEMO.service]);
    expect(rank[DEMO.service]).toBeLessThan(rank[DEMO.podA]);
    expect(rank[DEMO.deployment]).toBeLessThan(rank[DEMO.replicaSet]);
    expect(rank[DEMO.replicaSet]).toBeLessThan(rank[DEMO.podA]);
    expect(rank[DEMO.configMap]).toBe(rank[DEMO.podA] + 1);
  });
});

describe("layoutFocus", () => {
  it("places every node apart, left to right", () => {
    const model = demoModel();
    const ids = neighborhood(model, DEMO.podA, 2);
    const pos = layoutFocus(model, ids);
    expectPlacedApart(model, ids, pos);
    expect(pos[DEMO.ingressLb].x).toBeLessThan(pos[DEMO.podA].x);
  });

  it("runs top to bottom when vertical", () => {
    const model = demoModel();
    const ids = neighborhood(model, DEMO.podA, 2);
    const pos = layoutFocus(model, ids, true);
    expectPlacedApart(model, ids, pos);
    expect(pos[DEMO.ingressLb].y).toBeLessThan(pos[DEMO.podA].y);
  });
});

describe("layoutClusterLayered", () => {
  it("stacks one band per namespace after the cluster-scoped row", () => {
    const model = demoModel();
    const ids = model.nodes.map((n) => n.id);
    const pos = layoutClusterLayered(model, ids);
    expectPlacedApart(model, ids, pos);
    expect(pos[DEMO.ingressLb].y).toBe(0);
    expect(pos[DEMO.gatewayClass].y).toBe(0);
    expect(pos[DEMO.ingressLb].x).toBeLessThan(pos[DEMO.gatewayClass].x);
    const bottom = (ns: string) =>
      Math.max(
        ...model.nodes
          .filter((n) => n.namespace === ns)
          .map((n) => pos[n.id].y),
      );
    const top = (ns: string) =>
      Math.min(
        ...model.nodes
          .filter((n) => n.namespace === ns)
          .map((n) => pos[n.id].y),
      );
    expect(bottom("edge")).toBeLessThan(top("jobs"));
    expect(bottom("jobs")).toBeLessThan(top("shop"));
  });
});

describe("owners that own each other", () => {
  for (const size of [1, 2, 3]) {
    it(`draws a cycle of ${size} with every node placed`, () => {
      const { nodes, edges } = ownsCycle(size);
      const model = buildModel(nodes, edges);
      const ids = nodes.map((n) => n.id);
      expectPlacedApart(model, ids, layoutClusterLayered(model, ids));
      expectPlacedApart(model, ids, layoutFocus(model, ids));
    });
  }
});
