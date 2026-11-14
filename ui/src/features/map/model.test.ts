import { describe, expect, it } from "vitest";
import { DEMO, demoGraph, gedge, gnode } from "../../test/graph";
import { levelOf } from "./layout/constants";
import {
  autoHidden,
  buildModel,
  chipNamespaces,
  countText,
  FORCE_MAX_NODES,
  levelSort,
  linksOf,
  listLabel,
  MAX_NODES,
  missingText,
  namespaceView,
  statusLine,
  subscribedNamespaces,
  summaryText,
  summaryTitle,
  tooMany,
} from "./model";

function demoModel() {
  const { nodes, edges } = demoGraph();
  return buildModel(nodes, edges);
}

describe("buildModel", () => {
  it("indexes the nodes and the edges of each node", () => {
    const model = demoModel();
    expect(model.nodes).toHaveLength(22);
    expect(model.byId.get(DEMO.podA)?.name).toBe("web-7d9-a");
    expect(model.outgoing.get(DEMO.replicaSet)?.map((e) => e.to)).toEqual([
      DEMO.podA,
      DEMO.podB,
    ]);
    expect(model.incoming.get(DEMO.configMap)?.map((e) => e.from)).toEqual([
      DEMO.podA,
      DEMO.podB,
    ]);
  });

  it("drops edges whose ends are not nodes", () => {
    const a = gnode("Pod/shop/a");
    const model = buildModel(
      [a],
      [gedge(a.id, "mounts", "ConfigMap/shop/gone")],
    );
    expect(model.edges).toEqual([]);
    expect(linksOf(model, a.id)).toEqual([]);
  });

  it("lists a node's links, outgoing first", () => {
    expect(linksOf(demoModel(), DEMO.service)).toEqual([
      { other: DEMO.podA, rel: "selects", out: true },
      { other: DEMO.podB, rel: "selects", out: true },
      { other: DEMO.ingress, rel: "routes", out: false },
      { other: DEMO.route, rel: "routes", out: false },
    ]);
  });
});

describe("namespaceView", () => {
  it("draws every node when nothing is hidden", () => {
    expect(namespaceView(demoModel(), new Set())).toHaveLength(22);
  });

  it("adds what routes and class edges join to the shown namespaces", () => {
    expect(namespaceView(demoModel(), new Set(["shop", "jobs"]))).toEqual([
      DEMO.service,
      DEMO.ingress,
      DEMO.route,
      DEMO.gateway,
      DEMO.gatewayClass,
      DEMO.ingressLb,
      DEMO.gatewayLb,
    ]);
  });

  it("never brings in another namespace's Pods", () => {
    const ids = namespaceView(demoModel(), new Set(["shop", "edge"]));
    expect(ids).toEqual([DEMO.cronJob, DEMO.job, DEMO.jobPod, DEMO.token]);
  });

  it("brings in a shared GatewayClass or load balancer but never walks on from it", () => {
    const { nodes, edges } = demoGraph();
    const model = buildModel(
      [...nodes, gnode("Gateway/other/internal"), gnode("Ingress/other/admin")],
      [
        ...edges,
        gedge("Gateway/other/internal", "class", DEMO.gatewayClass),
        gedge(DEMO.ingressLb, "routes", "Ingress/other/admin"),
      ],
    );
    const ids = namespaceView(model, new Set(["edge", "jobs", "other"]));
    expect(ids).toContain(DEMO.gatewayClass);
    expect(ids).toContain(DEMO.ingressLb);
    expect(ids).not.toContain("Gateway/other/internal");
    expect(ids).not.toContain("Ingress/other/admin");
  });

  it("draws nothing when every namespace is hidden", () => {
    expect(
      namespaceView(demoModel(), new Set(["shop", "edge", "jobs"])),
    ).toEqual([]);
  });
});

describe("levels", () => {
  it("orders kinds the way in first and config last", () => {
    expect(levelOf("LoadBalancer")).toBe(0);
    expect(levelOf("HTTPRoute")).toBe(1);
    expect(levelOf("GatewayClass")).toBe(2);
    expect(levelOf("ReplicaSet")).toBe(3);
    expect(levelOf("Job")).toBe(4);
    expect(levelOf("Pod")).toBe(5);
    expect(levelOf("PersistentVolumeClaim")).toBe(9);
    expect(levelOf("Widget")).toBe(5);
  });

  it("sorts ids by level, then by name", () => {
    const model = demoModel();
    expect(
      levelSort(model, [DEMO.podB, DEMO.secret, DEMO.ingressLb, DEMO.podA]),
    ).toEqual([DEMO.ingressLb, DEMO.podA, DEMO.podB, DEMO.secret]);
  });
});

describe("namespaces", () => {
  const counts = [
    { namespace: "shop", nodes: 900 },
    { namespace: "argo", nodes: 400 },
    { namespace: "default", nodes: 0 },
    { namespace: "jobs", nodes: 300 },
  ];

  it("gives a chip to each namespace, by name", () => {
    expect(chipNamespaces(counts)).toEqual(["argo", "default", "jobs", "shop"]);
  });

  it("subscribes with null when nothing is hidden", () => {
    expect(subscribedNamespaces(["a", "b"], new Set())).toBeNull();
    expect(subscribedNamespaces(["a", "b", "c"], new Set(["b"]))).toEqual([
      "a",
      "c",
    ]);
  });

  it("hides nothing up to 1,500 nodes", () => {
    expect(MAX_NODES).toBe(1500);
    expect(autoHidden([{ namespace: "shop", nodes: 1500 }], null)).toBeNull();
  });

  it("keeps the default namespace when it has nodes", () => {
    expect(autoHidden(counts, "jobs")).toEqual(["argo", "default", "shop"]);
  });

  it("keeps the first namespace by name when the default one is empty", () => {
    expect(autoHidden(counts, "default")).toEqual(["default", "jobs", "shop"]);
    expect(autoHidden(counts, null)).toEqual(["default", "jobs", "shop"]);
  });

  it("knows when too many nodes are shown", () => {
    expect(FORCE_MAX_NODES).toBe(400);
    expect(tooMany(new Array(1500).fill("x"))).toBe(false);
    expect(tooMany(new Array(1501).fill("x"))).toBe(true);
  });
});

describe("texts", () => {
  it("counts resources and namespaces of what is drawn", () => {
    const model = demoModel();
    expect(
      summaryText(model, namespaceView(model, new Set()), {
        total: 22,
        filtering: false,
      }),
    ).toBe("22 resources · 3 namespaces · 16 kinds");
    expect(
      summaryText(model, [DEMO.gateway], { total: 22, filtering: true }),
    ).toBe("1 of 22 resources · 1 namespace · 1 kind");
    expect(summaryText(model, [DEMO.podA, DEMO.podB], null)).toBe(
      "2 resources",
    );
    expect(summaryTitle(true)).toBe(
      "Drawn now, of every resource in the cluster",
    );
    expect(summaryTitle(false)).toBe("Every resource in the cluster");
    expect(countText(1742, "resource", "resources")).toBe("1,742 resources");
  });

  it("names lists the way the sidebar does", () => {
    expect(listLabel("secrets")).toBe("Secrets");
    expect(listLabel("serviceaccounts")).toBe("ServiceAccounts");
    expect(listLabel("persistentvolumeclaims")).toBe("PersistentVolumeClaims");
    expect(listLabel("gatewayclasses")).toBe("GatewayClasses");
    expect(listLabel("httproutes")).toBe("HTTPRoutes");
    expect(listLabel("widgets")).toBe("widgets");
    expect(listLabel("widgets", "Widget")).toBe("Widgets");
  });

  it("says which kinds the user cannot list", () => {
    expect(missingText(["secrets", "serviceaccounts"])).toBe(
      "Not shown: you cannot list Secrets, ServiceAccounts.",
    );
  });

  it("falls back to the status word without a status text", () => {
    const model = demoModel();
    expect(statusLine(gnode("Pod/shop/x", { status: "critical" }))).toBe(
      "Failing",
    );
    expect(statusLine(gnode("Pod/shop/x"))).toBe("Healthy");
    const node = model.byId.get(DEMO.podB);
    expect(node && statusLine(node)).toBe("CrashLoopBackOff");
  });
});
