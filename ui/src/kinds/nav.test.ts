import { expect, test } from "vitest";
import type { ApiResourceInfo } from "../ipc/generated/ApiResourceInfo";
import {
  customResourceGroups,
  groupFromSegment,
  groupSegment,
  NAV_SECTIONS,
  navItemKey,
  resourcePath,
  visibleSections,
} from "./nav";

function info(
  group: string,
  plural: string,
  over: Partial<ApiResourceInfo> = {},
  kind = plural,
): ApiResourceInfo {
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
    ...over,
  };
}

const EXPECTED: [string, string[]][] = [
  ["nodes", ["/nodes"]],
  [
    "workloads",
    [
      "/pods",
      "apps/deployments",
      "apps/daemonsets",
      "apps/statefulsets",
      "apps/replicasets",
      "batch/jobs",
      "batch/cronjobs",
    ],
  ],
  [
    "config",
    [
      "/configmaps",
      "/secrets",
      "/resourcequotas",
      "/limitranges",
      "autoscaling/horizontalpodautoscalers",
      "policy/poddisruptionbudgets",
      "scheduling.k8s.io/priorityclasses",
      "node.k8s.io/runtimeclasses",
      "coordination.k8s.io/leases",
      "admissionregistration.k8s.io/mutatingwebhookconfigurations",
      "admissionregistration.k8s.io/validatingwebhookconfigurations",
    ],
  ],
  [
    "network",
    [
      "/services",
      "discovery.k8s.io/endpointslices",
      "networking.k8s.io/ingresses",
      "networking.k8s.io/ingressclasses",
      "networking.k8s.io/networkpolicies",
      "gateway.networking.k8s.io/gatewayclasses",
      "gateway.networking.k8s.io/gateways",
      "gateway.networking.k8s.io/httproutes",
      "gateway.networking.k8s.io/grpcroutes",
      "gateway.networking.k8s.io/referencegrants",
      "route:port-forwards",
    ],
  ],
  [
    "storage",
    [
      "/persistentvolumeclaims",
      "/persistentvolumes",
      "storage.k8s.io/storageclasses",
    ],
  ],
  ["namespaces", ["/namespaces"]],
  ["events", ["/events"]],
  ["helm", ["route:helm/charts", "route:helm/releases"]],
  [
    "argocd",
    [
      "argoproj.io/applications",
      "argoproj.io/applicationsets",
      "argoproj.io/appprojects",
    ],
  ],
  [
    "access",
    [
      "/serviceaccounts",
      "rbac.authorization.k8s.io/clusterroles",
      "rbac.authorization.k8s.io/roles",
      "rbac.authorization.k8s.io/clusterrolebindings",
      "rbac.authorization.k8s.io/rolebindings",
    ],
  ],
  ["custom", ["apiextensions.k8s.io/customresourcedefinitions"]],
];

const allServed = () =>
  NAV_SECTIONS.flatMap((s) => s.items).flatMap((i) =>
    i.type === "resource" ? [info(i.group, i.plural)] : [],
  );

test("NAV_SECTIONS covers every F4 resource", () => {
  const actual = NAV_SECTIONS.map((s) => [s.id, s.items.map(navItemKey)]);
  expect(actual).toEqual(EXPECTED);
  expect(NAV_SECTIONS.map((s) => s.label)).toEqual([
    "Nodes",
    "Workloads",
    "Config",
    "Network",
    "Storage",
    "Namespaces",
    "Events",
    "Helm",
    "Argo CD",
    "Access Control",
    "Custom Resources",
  ]);
  expect(visibleSections(allServed())).toEqual(NAV_SECTIONS);
});

test("items not served are hidden", () => {
  const served = allServed().filter((r) => r.resource.plural !== "cronjobs");
  const workloads = visibleSections(served).find((s) => s.id === "workloads");
  expect(workloads?.items.map(navItemKey)).not.toContain("batch/cronjobs");
  expect(workloads?.items.map(navItemKey)).toContain("batch/jobs");
});

test("items the user cannot list are hidden", () => {
  const served = allServed().map((r) =>
    r.resource.plural === "secrets" ? { ...r, canList: false } : r,
  );
  const config = visibleSections(served).find((s) => s.id === "config");
  expect(config?.items.map(navItemKey)).not.toContain("/secrets");
  expect(config?.items.map(navItemKey)).toContain("/configmaps");
});

test("sections with no visible items disappear; routes need no listable resource", () => {
  const shape = (resources: ApiResourceInfo[]) =>
    visibleSections(resources).map((s) => [s.id, s.items.map(navItemKey)]);
  const helm: [string, string[]] = [
    "helm",
    ["route:helm/charts", "route:helm/releases"],
  ];
  expect(
    shape([info("", "pods"), info("", "nodes", { canList: false })]),
  ).toEqual([
    ["workloads", ["/pods"]],
    ["network", ["route:port-forwards"]],
    helm,
  ]);
  expect(shape([])).toEqual([["network", ["route:port-forwards"]], helm]);
});

test("Helm and Argo CD sit between Events and Access Control", () => {
  const ids = NAV_SECTIONS.map((s) => s.id);
  expect(ids.slice(ids.indexOf("events"), ids.indexOf("events") + 4)).toEqual([
    "events",
    "helm",
    "argocd",
    "access",
  ]);
  expect(NAV_SECTIONS.find((s) => s.id === "helm")).toEqual({
    id: "helm",
    label: "Helm",
    items: [
      { type: "route", label: "Charts", path: "helm/charts" },
      { type: "route", label: "Releases", path: "helm/releases" },
    ],
  });
});

test("the Network group ends with Port Forwarding, a route of the cluster screen", () => {
  expect(NAV_SECTIONS.find((s) => s.id === "network")?.items.at(-1)).toEqual({
    type: "route",
    label: "Port Forwarding",
    path: "port-forwards",
  });
});

test("custom resources group by API group and exclude built-ins", () => {
  const groups = customResourceGroups([
    info("", "pods"),
    info("apps", "deployments"),
    info("apiextensions.k8s.io", "customresourcedefinitions"),
    info("zeta.io", "widgets", {}, "Widget"),
    info("acme.io", "gadgets", {}, "Gadget"),
    info("acme.io", "bolts", {}, "Bolt"),
    info("acme.io", "hidden", { canList: false }, "Hidden"),
  ]);
  expect(groups).toEqual([
    {
      group: "acme.io",
      items: [
        { label: "Bolt", plural: "bolts" },
        { label: "Gadget", plural: "gadgets" },
      ],
    },
    { group: "zeta.io", items: [{ label: "Widget", plural: "widgets" }] },
  ]);
});

test("the core group is spelled core in URLs", () => {
  expect(groupSegment("")).toBe("core");
  expect(groupSegment("apps")).toBe("apps");
  expect(groupFromSegment("core")).toBe("");
  expect(groupFromSegment("apps")).toBe("apps");
  expect(resourcePath("c1", "", "pods")).toBe("/cluster/c1/r/core/pods");
});

test("Workloads has an Overview entry and no other section does", () => {
  expect(
    NAV_SECTIONS.filter((s) => s.overview !== undefined).map((s) => [
      s.id,
      s.overview,
    ]),
  ).toEqual([["workloads", "workloads"]]);
  expect(
    visibleSections(allServed()).find((s) => s.id === "workloads")?.overview,
  ).toBe("workloads");
});

test("each Argo CD page shows only when its kind is served", () => {
  const argo = (resources: ApiResourceInfo[]) =>
    visibleSections(resources)
      .find((s) => s.id === "argocd")
      ?.items.map(navItemKey);
  expect(argo([info("", "pods")])).toBeUndefined();
  expect(
    argo([
      info("argoproj.io", "applications"),
      info("argoproj.io", "appprojects"),
    ]),
  ).toEqual(["argoproj.io/applications", "argoproj.io/appprojects"]);
});

test("the Gateway API kinds sit in Network between NetworkPolicies and Port Forwarding", () => {
  const keys =
    NAV_SECTIONS.find((s) => s.id === "network")?.items.map(navItemKey) ?? [];
  const at = keys.indexOf("networking.k8s.io/networkpolicies");
  expect(keys.slice(at + 1)).toEqual([
    "gateway.networking.k8s.io/gatewayclasses",
    "gateway.networking.k8s.io/gateways",
    "gateway.networking.k8s.io/httproutes",
    "gateway.networking.k8s.io/grpcroutes",
    "gateway.networking.k8s.io/referencegrants",
    "route:port-forwards",
  ]);
});

test("custom resources leave out the kinds a section lists, matched per resource", () => {
  const groups = customResourceGroups([
    info("argoproj.io", "applications", {}, "Application"),
    info("argoproj.io", "appprojects", {}, "AppProject"),
    info("argoproj.io", "rollouts", {}, "Rollout"),
    info("gateway.networking.k8s.io", "gateways", {}, "Gateway"),
    info("gateway.networking.k8s.io", "tlsroutes", {}, "TLSRoute"),
  ]);
  expect(groups).toEqual([
    { group: "argoproj.io", items: [{ label: "Rollout", plural: "rollouts" }] },
    {
      group: "gateway.networking.k8s.io",
      items: [{ label: "TLSRoute", plural: "tlsroutes" }],
    },
  ]);
});
