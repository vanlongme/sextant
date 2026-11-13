import { describe, expect, it } from "vitest";
import { demoGraph, ownsCycle } from "../../../test/graph";
import { buildModel } from "../model";
import { hashId, layoutCluster } from "./force";

function demoModel() {
  const { nodes, edges } = demoGraph();
  return buildModel(nodes, edges);
}

describe("layoutCluster", () => {
  it("places every node", () => {
    const model = demoModel();
    const ids = model.nodes.map((n) => n.id);
    const pos = layoutCluster(model, ids);
    for (const id of ids) {
      expect(
        Number.isFinite(pos[id]?.x) && Number.isFinite(pos[id]?.y),
        id,
      ).toBe(true);
    }
  });

  it("gives the same positions twice for the same graph", () => {
    const ids = demoModel().nodes.map((n) => n.id);
    expect(layoutCluster(demoModel(), ids)).toEqual(
      layoutCluster(demoModel(), ids),
    );
  });

  it("keeps each namespace in a block of its own", () => {
    const model = demoModel();
    const pos = layoutCluster(
      model,
      model.nodes.map((n) => n.id),
    );
    const span = (ns: string) => {
      const xs = model.nodes
        .filter((n) => n.namespace === ns)
        .map((n) => pos[n.id]);
      return {
        x0: Math.min(...xs.map((p) => p.x)),
        x1: Math.max(...xs.map((p) => p.x)),
        y0: Math.min(...xs.map((p) => p.y)),
        y1: Math.max(...xs.map((p) => p.y)),
      };
    };
    const names = ["", "edge", "jobs", "shop"];
    for (const a of names) {
      for (const b of names) {
        if (a >= b) continue;
        const p = span(a);
        const q = span(b);
        const hit =
          p.x0 <= q.x1 && q.x0 <= p.x1 && p.y0 <= q.y1 && q.y0 <= p.y1;
        expect(hit, `${a} and ${b}`).toBe(false);
      }
    }
  });

  it("seeds from the id alone", () => {
    expect(hashId("Pod/shop/a")).toBe(hashId("Pod/shop/a"));
    expect(hashId("Pod/shop/a")).not.toBe(hashId("Pod/shop/b"));
  });

  it("draws owners that own each other", () => {
    const { nodes, edges } = ownsCycle(3);
    const pos = layoutCluster(
      buildModel(nodes, edges),
      nodes.map((n) => n.id),
    );
    expect(Object.keys(pos)).toHaveLength(4);
  });
});
