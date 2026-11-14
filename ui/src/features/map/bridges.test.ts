import { describe, expect, it } from "vitest";
import type { GraphEdge } from "../../ipc/generated/GraphEdge";
import type { GraphNode } from "../../ipc/generated/GraphNode";
import { DEMO, demoGraph, gedge, gnode, ownsCycle } from "../../test/graph";
import { bridgeEdges } from "./bridges";
import { kindView } from "./filters";
import { buildModel, namespaceView } from "./model";

function bridgesHiding(
  kinds: string[],
  nodes?: GraphNode[],
  edges?: GraphEdge[],
) {
  const graph = nodes && edges ? { nodes, edges } : demoGraph();
  const model = buildModel(graph.nodes, graph.edges);
  const view = namespaceView(model, new Set());
  const shown = new Set(kindView(model, view, new Set(kinds)));
  return bridgeEdges(model, view, shown);
}

describe("bridgeEdges", () => {
  it("returns nothing when nothing is hidden", () => {
    expect(bridgesHiding([])).toEqual([]);
  });

  it("lifts ownership to the nearest shown owner", () => {
    expect(bridgesHiding(["ReplicaSet"])).toEqual([
      {
        from: DEMO.deployment,
        to: DEMO.podA,
        rel: "owns",
        via: ["ReplicaSet"],
      },
      {
        from: DEMO.deployment,
        to: DEMO.podB,
        rel: "owns",
        via: ["ReplicaSet"],
      },
    ]);
  });

  it("carries traffic through hidden nodes with the rel of the last hop", () => {
    expect(bridgesHiding(["Service"])).toEqual([
      { from: DEMO.ingress, to: DEMO.podA, rel: "selects", via: ["Service"] },
      { from: DEMO.ingress, to: DEMO.podB, rel: "selects", via: ["Service"] },
      { from: DEMO.route, to: DEMO.podA, rel: "selects", via: ["Service"] },
      { from: DEMO.route, to: DEMO.podB, rel: "selects", via: ["Service"] },
    ]);
  });

  it("passes the uses of a hidden node to its shown owner", () => {
    expect(bridgesHiding(["Pod"])).toEqual([
      { from: DEMO.service, to: DEMO.replicaSet, rel: "selects", via: ["Pod"] },
      {
        from: DEMO.replicaSet,
        to: DEMO.configMap,
        rel: "mounts",
        via: ["Pod"],
      },
      { from: DEMO.replicaSet, to: DEMO.secret, rel: "env", via: ["Pod"] },
      { from: DEMO.replicaSet, to: DEMO.account, rel: "runsAs", via: ["Pod"] },
      { from: DEMO.replicaSet, to: DEMO.claim, rel: "claims", via: ["Pod"] },
      { from: DEMO.statefulSet, to: DEMO.dbClaim, rel: "claims", via: ["Pod"] },
      { from: DEMO.job, to: DEMO.token, rel: "env", via: ["Pod"] },
    ]);
  });

  it("names every hidden kind on the way, nearest first", () => {
    const bridges = bridgesHiding(["Pod", "ReplicaSet"]);
    expect(bridges).toContainEqual({
      from: DEMO.service,
      to: DEMO.deployment,
      rel: "selects",
      via: ["Pod", "ReplicaSet"],
    });
    expect(bridges).toContainEqual({
      from: DEMO.deployment,
      to: DEMO.configMap,
      rel: "mounts",
      via: ["Pod", "ReplicaSet"],
    });
  });

  it("unites the via lists of merged bridges in first-seen order", () => {
    const nodes = [
      gnode("Service/n/s"),
      gnode("Pod/n/p"),
      gnode("ReplicaSet/n/r"),
      gnode("Deployment/n/d"),
      gnode("Widget/n/w", { group: "acme.io", plural: "widgets" }),
    ];
    const edges = [
      gedge("Deployment/n/d", "owns", "ReplicaSet/n/r"),
      gedge("ReplicaSet/n/r", "owns", "Pod/n/p"),
      gedge("Deployment/n/d", "owns", "Widget/n/w"),
      gedge("Service/n/s", "selects", "Pod/n/p"),
      gedge("Service/n/s", "routes", "Widget/n/w"),
    ];
    expect(
      bridgesHiding(["Pod", "ReplicaSet", "Widget"], nodes, edges),
    ).toEqual([
      {
        from: "Service/n/s",
        to: "Deployment/n/d",
        rel: "selects",
        via: ["Pod", "ReplicaSet", "Widget"],
      },
    ]);
  });

  it("drops self-loops, bridges a real edge already joins, and hidden nodes with no shown owner", () => {
    const nodes = [
      gnode("Deployment/n/d"),
      gnode("Pod/n/p"),
      gnode("Pod/n/orphan"),
      gnode("ConfigMap/n/c"),
      gnode("ConfigMap/n/back"),
      gnode("Service/n/s"),
    ];
    const edges = [
      gedge("Deployment/n/d", "owns", "Pod/n/p"),
      gedge("Pod/n/p", "mounts", "ConfigMap/n/c"),
      gedge("Deployment/n/d", "mounts", "ConfigMap/n/c"),
      gedge("Pod/n/p", "env", "ConfigMap/n/back"),
      gedge("ConfigMap/n/back", "owns", "Deployment/n/d"),
      gedge("Pod/n/p", "runsAs", "Deployment/n/d"),
      gedge("Service/n/s", "selects", "Pod/n/orphan"),
      gedge("Pod/n/orphan", "mounts", "ConfigMap/n/c"),
    ];
    expect(bridgesHiding(["Pod"], nodes, edges)).toEqual([]);
  });

  it("ignores nodes outside the view", () => {
    const graph = demoGraph();
    const model = buildModel(graph.nodes, graph.edges);
    const view = namespaceView(model, new Set(["shop"]));
    const shown = new Set(kindView(model, view, new Set(["Pod"])));
    const bridges = bridgeEdges(model, view, shown);
    expect(
      bridges.every((b) => view.includes(b.from) && view.includes(b.to)),
    ).toBe(true);
    expect(bridges.some((b) => b.from === DEMO.replicaSet)).toBe(false);
  });

  it("an owner cycle among hidden nodes ends", () => {
    const { nodes, edges } = ownsCycle(3);
    expect(bridgesHiding(["ReplicaSet"], nodes, edges)).toEqual([]);
    const one = ownsCycle(1);
    expect(bridgesHiding(["ReplicaSet"], one.nodes, one.edges)).toEqual([]);
  });

  it("a traffic cycle among hidden nodes ends", () => {
    const nodes = [
      gnode("Ingress/n/i"),
      gnode("Service/n/a"),
      gnode("Service/n/b"),
    ];
    const edges = [
      gedge("Ingress/n/i", "routes", "Service/n/a"),
      gedge("Service/n/a", "routes", "Service/n/b"),
      gedge("Service/n/b", "routes", "Service/n/a"),
    ];
    expect(bridgesHiding(["Service"], nodes, edges)).toEqual([]);
  });

  it("a chain of 10,000 hidden nodes runs without a stack overflow", () => {
    const n = 10_000;
    const sets = Array.from({ length: n }, (_, i) =>
      gnode(`ReplicaSet/n/r${i}`),
    );
    const nodes = [
      gnode("Deployment/n/top"),
      gnode("Pod/n/leaf"),
      gnode("Service/n/s"),
      ...sets,
    ];
    const edges = [
      gedge("Deployment/n/top", "owns", sets[0].id),
      ...sets.slice(1).map((s, i) => gedge(sets[i].id, "owns", s.id)),
      gedge(sets[n - 1].id, "owns", "Pod/n/leaf"),
      gedge("Service/n/s", "selects", sets[0].id),
      ...sets.slice(1).map((s, i) => gedge(sets[i].id, "selects", s.id)),
    ];
    const bridges = bridgesHiding(["ReplicaSet"], nodes, edges);
    expect(bridges).toEqual([
      {
        from: "Deployment/n/top",
        to: "Pod/n/leaf",
        rel: "owns",
        via: ["ReplicaSet"],
      },
      {
        from: "Service/n/s",
        to: "Deployment/n/top",
        rel: "selects",
        via: ["ReplicaSet"],
      },
    ]);
  });
});
