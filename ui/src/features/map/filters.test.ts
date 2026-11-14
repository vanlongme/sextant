import { describe, expect, it } from "vitest";
import { DEMO, demoGraph, gedge, gnode } from "../../test/graph";
import {
  filtersActive,
  graphTotal,
  groupState,
  hideListed,
  kindGroups,
  kindTrigger,
  kindView,
  matchesKind,
  namespaceTrigger,
  showListed,
  tally,
  toggleGroup,
  visibleModel,
} from "./filters";
import { buildModel, namespaceView } from "./model";

function demoModel() {
  const { nodes, edges } = demoGraph();
  return buildModel(nodes, edges);
}

describe("kindGroups", () => {
  it("groups the present kinds by sidebar section, in the sidebar's order", () => {
    const model = demoModel();
    const groups = kindGroups(model, namespaceView(model, new Set()));
    expect(
      groups.map((g) => [
        g.id,
        g.label,
        g.nodes,
        g.kinds.map((k) => [k.label, k.nodes]),
      ]),
    ).toEqual([
      [
        "workloads",
        "Workloads",
        9,
        [
          ["Pods", 4],
          ["Deployments", 1],
          ["StatefulSets", 1],
          ["ReplicaSets", 1],
          ["Jobs", 1],
          ["CronJobs", 1],
        ],
      ],
      [
        "config",
        "Config",
        3,
        [
          ["ConfigMaps", 1],
          ["Secrets", 2],
        ],
      ],
      [
        "network",
        "Network",
        5,
        [
          ["Services", 1],
          ["Ingresses", 1],
          ["GatewayClasses", 1],
          ["Gateways", 1],
          ["HTTPRoutes", 1],
        ],
      ],
      ["storage", "Storage", 2, [["PersistentVolumeClaims", 2]]],
      ["access", "Access Control", 1, [["ServiceAccounts", 1]]],
      ["outside", "Outside the cluster", 2, [["Load balancers", 2]]],
    ]);
    expect(groups[0].kinds[0].kind).toBe("Pod");
    expect(groups[5].kinds[0].kind).toBe("LoadBalancer");
  });

  it("counts only the view, and puts unlisted kinds in Other before Outside", () => {
    const model = buildModel(
      [
        gnode("Pod/a/p"),
        gnode("Widget/a/w", { group: "acme.io", plural: "widgets" }),
        gnode("Gadget/a/g", { group: "acme.io", plural: "gadgets" }),
        gnode("LoadBalancer//1.2.3.4"),
      ],
      [],
    );
    const groups = kindGroups(model, [
      "Widget/a/w",
      "Gadget/a/g",
      "LoadBalancer//1.2.3.4",
    ]);
    expect(groups.map((g) => [g.id, g.kinds.map((k) => k.label)])).toEqual([
      ["other", ["Gadgets", "Widgets"]],
      ["outside", ["Load balancers"]],
    ]);
  });
});

describe("the view and the drawn model", () => {
  it("kindView drops the nodes of hidden kinds", () => {
    const model = demoModel();
    const view = namespaceView(model, new Set());
    const shown = kindView(model, view, new Set(["Pod", "ReplicaSet"]));
    expect(shown).not.toContain(DEMO.podA);
    expect(shown).not.toContain(DEMO.replicaSet);
    expect(shown).toContain(DEMO.deployment);
    expect(shown).toHaveLength(17);
    expect(kindView(model, view, new Set())).toEqual(view);
  });

  it("visibleModel keeps real edges between shown nodes and adds the bridges", () => {
    const model = demoModel();
    const shown = kindView(
      model,
      namespaceView(model, new Set()),
      new Set(["ReplicaSet"]),
    );
    const drawn = visibleModel(model, shown, [
      {
        from: DEMO.deployment,
        rel: "owns",
        to: DEMO.podA,
        via: ["ReplicaSet"],
      },
    ]);
    expect(drawn.byId.has(DEMO.replicaSet)).toBe(false);
    expect(
      drawn.edges.some(
        (e) => e.from === DEMO.replicaSet || e.to === DEMO.replicaSet,
      ),
    ).toBe(false);
    expect(drawn.outgoing.get(DEMO.deployment)).toContainEqual({
      from: DEMO.deployment,
      rel: "owns",
      to: DEMO.podA,
      via: ["ReplicaSet"],
    });
  });

  it("the whole graph counts the namespaces' nodes and the cluster-scoped ones", () => {
    const model = demoModel();
    expect(
      graphTotal(model, [
        { namespace: "edge", nodes: 1 },
        { namespace: "jobs", nodes: 4 },
        { namespace: "shop", nodes: 14 },
      ]),
    ).toBe(22);
  });
});

describe("trigger texts and tools", () => {
  it("names the shown namespaces", () => {
    const all = ["edge", "jobs", "shop"];
    expect(namespaceTrigger(all, new Set())).toEqual({
      label: "All namespaces",
      title: "All namespaces",
    });
    expect(namespaceTrigger(all, new Set(all))).toEqual({
      label: "No namespaces",
      title: "No namespaces",
    });
    expect(namespaceTrigger(all, new Set(["edge", "jobs"]))).toEqual({
      label: "shop",
      title: "Namespaces: shop",
    });
    expect(namespaceTrigger(all, new Set(["edge"]))).toEqual({
      label: "2 namespaces",
      title: "Namespaces: jobs, shop",
    });
    expect(namespaceTrigger(all, new Set(["gone"])).label).toBe(
      "All namespaces",
    );
  });

  it("names the hidden kinds", () => {
    const model = demoModel();
    const groups = kindGroups(model, namespaceView(model, new Set()));
    expect(kindTrigger(groups, new Set(["Absent"]))).toEqual({
      label: "All kinds",
      title: "All kinds",
    });
    expect(kindTrigger(groups, new Set(["Pod", "Secret"]))).toEqual({
      label: "14 of 16 kinds",
      title: "Hidden: Pods, Secrets",
    });
    const every = new Set(groups.flatMap((g) => g.kinds.map((k) => k.kind)));
    expect(kindTrigger(groups, every).label).toBe("No kinds");
    expect(
      kindTrigger(groups, every).title.startsWith("Hidden: Pods, Deployments"),
    ).toBe(true);
  });

  it("tallies, shows and hides the listed rows", () => {
    expect(tally(1234, 2000)).toBe("1,234 of 2,000");
    expect(showListed(["a", "b", "c"], ["b", "x"])).toEqual(["a", "c"]);
    expect(hideListed(["c", "a"], ["b", "a"])).toEqual(["a", "b", "c"]);
  });

  it("a group's checkbox is all, some or none, and a click hides all or shows all", () => {
    const rows = [
      { kind: "Pod", label: "Pods", nodes: 4 },
      { kind: "Job", label: "Jobs", nodes: 1 },
    ];
    expect(groupState(rows, new Set())).toBe("all");
    expect(groupState(rows, new Set(["Pod"]))).toBe("some");
    expect(groupState(rows, new Set(["Pod", "Job"]))).toBe("none");
    expect(toggleGroup(rows, ["Secret"])).toEqual(["Job", "Pod", "Secret"]);
    expect(toggleGroup(rows, ["Pod", "Secret"])).toEqual(["Secret"]);
    expect(toggleGroup(rows, ["Job", "Pod"])).toEqual([]);
  });

  it("a kind matches by label, kind or group label, ignoring case", () => {
    const row = { kind: "HTTPRoute", label: "HTTPRoutes", nodes: 1 };
    expect(matchesKind(row, "Network", "httpr")).toBe(true);
    expect(matchesKind(row, "Network", "NETW")).toBe(true);
    expect(matchesKind(row, "Network", "pod")).toBe(false);
    expect(matchesKind(row, "Network", "  ")).toBe(true);
  });

  it("filters are active only for a hidden listed namespace or a hidden present kind", () => {
    const model = buildModel(
      [gnode("Pod/a/p")],
      [gedge("Pod/a/p", "owns", "Pod/a/p")],
    );
    const groups = kindGroups(model, ["Pod/a/p"]);
    expect(filtersActive(["a"], new Set(), groups, new Set())).toBe(false);
    expect(
      filtersActive(["a"], new Set(["gone"]), groups, new Set(["Secret"])),
    ).toBe(false);
    expect(filtersActive(["a"], new Set(["a"]), groups, new Set())).toBe(true);
    expect(filtersActive(["a"], new Set(), groups, new Set(["Pod"]))).toBe(
      true,
    );
  });
});
