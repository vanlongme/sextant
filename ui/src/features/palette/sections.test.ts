import { Server } from "lucide-react";
import { expect, test, vi } from "vitest";
import type { CommandContext } from "../../app/commands";
import { toast } from "../../design";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { ClusterInfo } from "../../ipc/generated/ClusterInfo";
import { clusterEntry, mockBackend } from "../../test/ipc";
import {
  buildSections,
  CAPS,
  clusterEntries,
  commandEntries,
  objectEntries,
  type PaletteEntry,
  type PaletteInput,
  type PaletteSection,
  pageEntries,
} from "./sections";

function entry(key: string, label: string, hint = "Command"): PaletteEntry {
  return { key, testId: key, label, hint, icon: Server, run: () => {} };
}

function many(prefix: string, count: number, hint: string): PaletteEntry[] {
  return Array.from({ length: count }, (_, i) =>
    entry(`${prefix}-${i}`, `item ${prefix} ${i}`, hint),
  );
}

const BASE: PaletteInput = {
  query: "",
  clusterName: "prod",
  commands: many("command", 10, "Command"),
  clusters: many("cluster", 9, "Connected"),
  pages: many("page", 10, "Page"),
  objects: many("object", 20, "Pod · default"),
  objectsStatus: null,
};

function counts(sections: PaletteSection[]): Record<string, number> {
  return Object.fromEntries(sections.map((s) => [s.id, s.rows.length]));
}

const INFO: ClusterInfo = {
  version: "v1.31.0",
  distribution: "kind",
  nodeCount: 1,
  namespaces: ["default"],
  namespacesRestricted: false,
  isAdmin: true,
};

function context() {
  const navigate = vi.fn<(to: string | number) => void>();
  const ctx: CommandContext & { navigate: typeof navigate } = {
    navigate,
    pathname: "/catalog",
    cluster: null,
  };
  return ctx;
}

function info(group: string, plural: string, kind: string): ApiResourceInfo {
  return {
    resource: { group, version: "v1", plural, kind, namespaced: true },
    verbs: ["list", "watch"],
    shortNames: [],
    canList: true,
    canWatch: true,
    canCreate: true,
    canUpdate: true,
    canPatch: true,
    canDelete: true,
  };
}

test("the caps follow the spec", () => {
  expect(CAPS).toEqual({
    commands: { idle: 6, query: 8 },
    clusters: { idle: 8, query: 6 },
    pages: { idle: 0, query: 8 },
    objects: { idle: 0, query: 12 },
  });
});

test("without a query: Commands 6 and Clusters 8, in that order", () => {
  const sections = buildSections(BASE);
  expect(sections.map((s) => [s.id, s.heading, s.rows.length])).toEqual([
    ["commands", "Commands", 6],
    ["clusters", "Clusters", 8],
  ]);
});

test("a query of spaces is no query", () => {
  expect(buildSections({ ...BASE, query: "   " })).toEqual(buildSections(BASE));
});

test("with a query: Commands 8, Clusters 6, Pages 8 and Objects 12", () => {
  const sections = buildSections({ ...BASE, query: "item" });
  expect(counts(sections)).toEqual({
    commands: 8,
    clusters: 6,
    pages: 8,
    objects: 12,
  });
  expect(sections.map((s) => s.heading)).toContain("Pages in prod");
  expect(sections.map((s) => s.heading)).toContain("Objects in prod");
});

test("rows keep score order and sections sort by their best row", () => {
  const sections = buildSections({
    ...BASE,
    query: "web",
    commands: [entry("c1", "Show keyboard shortcuts"), entry("c2", "Go back")],
    clusters: [],
    pages: [],
    objects: [
      entry("o1", "my-web-2", "Pod · default"),
      entry("o2", "web-1", "Pod · default"),
    ],
  });
  expect(sections.map((s) => [s.id, s.rows.map((r) => r.key)])).toEqual([
    ["objects", ["o2", "o1"]],
    ["commands", ["c1"]],
  ]);
});

test("only Clusters and Objects match their hint, and without marks", () => {
  const sections = buildSections({
    ...BASE,
    query: "default",
    commands: [entry("c1", "Open", "default")],
    clusters: [entry("k1", "alpha", "default")],
    pages: [entry("p1", "Pods", "default")],
    objects: [entry("o1", "web-1", "Pod · default")],
  });
  expect(sections.map((s) => s.id).sort()).toEqual(["clusters", "objects"]);
  expect(sections.flatMap((s) => s.rows.map((r) => r.ranges))).toEqual([
    [],
    [],
  ]);
});

test("the Objects status row shows with a query while names load or failed", () => {
  const loading = buildSections({
    ...BASE,
    query: "item",
    objects: null,
    objectsStatus: "Loading objects…",
  });
  expect(loading.at(-1)).toEqual({
    id: "objects",
    heading: "Objects in prod",
    rows: [],
    status: "Loading objects…",
  });
  const idle = buildSections({
    ...BASE,
    objects: null,
    objectsStatus: "Loading objects…",
  });
  expect(idle.map((s) => s.id)).toEqual(["commands", "clusters"]);
  const off = buildSections({
    ...BASE,
    query: "item",
    pages: null,
    objects: null,
    objectsStatus: null,
  });
  expect(off.map((s) => s.id).sort()).toEqual(["clusters", "commands"]);
});

test("command rows hint their first chord, or Command", () => {
  const rows = commandEntries(context(), false);
  expect(rows.slice(0, 3).map((r) => [r.testId, r.label, r.hint])).toEqual([
    ["palette-command-catalog", "Go to the catalog", "Command"],
    ["palette-command-preferences", "Open Preferences", "Ctrl+,"],
    ["palette-command-add-cluster", "Add a cluster", "Command"],
  ]);
  expect(
    commandEntries(context(), true).find((r) => r.key === "back")?.hint,
  ).toBe("⌥←");
});

test("cluster rows hint the connection state and open the cluster", () => {
  const [row] = clusterEntries([
    clusterEntry({ id: "a/b", contextName: "alpha" }),
  ]);
  expect([row.testId, row.label, row.hint]).toEqual([
    "palette-cluster-a/b",
    "alpha",
    "Disconnected",
  ]);
  const ctx = context();
  row.run(ctx);
  expect(ctx.navigate).toHaveBeenCalledWith("/cluster/a%2Fb");
});

test("the open cluster's row connects it again after a disconnect", async () => {
  const ipc = mockBackend({
    cluster_connect: () => ({ status: "connecting" }),
  });
  const [row] = clusterEntries([
    clusterEntry({ id: "c1", contextName: "alpha" }),
  ]);
  const ctx = context();
  ctx.pathname = "/cluster/c1/pods";
  ctx.cluster = { id: "c1", name: "alpha", state: { status: "disconnected" } };
  row.run(ctx);
  await vi.waitFor(() =>
    expect(ipc.callsTo("cluster_connect")).toEqual([{ id: "c1" }]),
  );
  expect(ctx.navigate).not.toHaveBeenCalled();
});

test("the open cluster's row only opens it while it is connected or connecting", () => {
  const ipc = mockBackend({});
  const [row] = clusterEntries([
    clusterEntry({ id: "c1", contextName: "alpha" }),
  ]);
  for (const state of [
    { status: "connecting" },
    { status: "connected", info: INFO },
  ] as const) {
    const ctx = context();
    ctx.pathname = "/cluster/c1";
    ctx.cluster = { id: "c1", name: "alpha", state };
    row.run(ctx);
    expect(ctx.navigate).toHaveBeenCalledWith("/cluster/c1");
  }
  expect(ipc.callsTo("cluster_connect")).toEqual([]);
});

test("a connect that fails from the palette toasts as the screen does", async () => {
  mockBackend({
    cluster_connect: () => {
      throw { code: "Internal", message: "boom", details: null };
    },
  });
  const failed = vi.spyOn(toast, "error");
  const [row] = clusterEntries([
    clusterEntry({ id: "c1", contextName: "alpha" }),
  ]);
  const ctx = context();
  ctx.cluster = {
    id: "c1",
    name: "alpha",
    state: { status: "failed", kind: "unreachable", message: "timed out" },
  };
  row.run(ctx);
  await vi.waitFor(() =>
    expect(failed).toHaveBeenCalledWith("Could not connect", "boom"),
  );
  failed.mockRestore();
});

test("pages follow the sidebar: the overviews, its items, then custom resources", () => {
  const pages = pageEntries("c1", [
    info("", "pods", "Pod"),
    info("", "configmaps", "ConfigMap"),
    info("example.com", "widgets", "Widget"),
  ]);
  expect(pages.map((p) => [p.testId, p.label, p.hint])).toEqual([
    ["palette-page-overview", "Overview", "Page"],
    ["palette-page-workloads", "Workloads overview", "Page"],
    ["palette-page-r/core/pods", "Pods", "Page"],
    ["palette-page-r/core/configmaps", "ConfigMaps", "Page"],
    ["palette-page-port-forwards", "Port Forwarding", "Page"],
    ["palette-page-helm/charts", "Charts", "Page"],
    ["palette-page-helm/releases", "Releases", "Page"],
    ["palette-page-r/example.com/widgets", "Widget", "Page"],
  ]);
  const ctx = context();
  for (const page of pages) page.run(ctx);
  expect(ctx.navigate.mock.calls).toEqual([
    ["/cluster/c1"],
    ["/cluster/c1/workloads"],
    ["/cluster/c1/r/core/pods"],
    ["/cluster/c1/r/core/configmaps"],
    ["/cluster/c1/port-forwards"],
    ["/cluster/c1/helm/charts"],
    ["/cluster/c1/helm/releases"],
    ["/cluster/c1/r/example.com/widgets"],
  ]);
});

test("without discovery, Pages hold the overview and the routes", () => {
  expect(pageEntries("c1", []).map((p) => p.testId)).toEqual([
    "palette-page-overview",
    "palette-page-port-forwards",
    "palette-page-helm/charts",
    "palette-page-helm/releases",
  ]);
});

test("object rows carry the namespace in their id and hint, and open with ?object=", () => {
  const rows = objectEntries("c1", [
    {
      kind: "ConfigMap",
      group: "",
      plural: "configmaps",
      namespace: "default",
      name: "kube-root-ca.crt",
    },
    {
      kind: "Node",
      group: "",
      plural: "nodes",
      namespace: null,
      name: "node-a",
    },
    {
      kind: "Ingress",
      group: "networking.k8s.io",
      plural: "ingresses",
      namespace: "web",
      name: "site",
    },
  ]);
  expect(rows.map((r) => [r.testId, r.label, r.hint])).toEqual([
    [
      "palette-object-configmaps-default-kube-root-ca.crt",
      "kube-root-ca.crt",
      "ConfigMap · default",
    ],
    ["palette-object-nodes-node-a", "node-a", "Node"],
    ["palette-object-ingresses-web-site", "site", "Ingress · web"],
  ]);
  const ctx = context();
  for (const row of rows) row.run(ctx);
  expect(ctx.navigate.mock.calls).toEqual([
    ["/cluster/c1/r/core/configmaps?object=default%2Fkube-root-ca.crt"],
    ["/cluster/c1/r/core/nodes?object=%2Fnode-a"],
    ["/cluster/c1/r/networking.k8s.io/ingresses?object=web%2Fsite"],
  ]);
});
