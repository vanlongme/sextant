import { expect, test } from "vitest";
import type { ApiResourceInfo } from "../ipc/generated/ApiResourceInfo";
import {
  customResourceGroups,
  groupFromSegment,
  groupSegment,
  NAV_SECTIONS,
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
  NAV_SECTIONS.flatMap((s) => s.items).map((i) => info(i.group, i.plural));

test("NAV_SECTIONS covers every F4 resource", () => {
  const actual = NAV_SECTIONS.map((s) => [
    s.id,
    s.items.map((i) => `${i.group}/${i.plural}`),
  ]);
  expect(actual).toEqual(EXPECTED);
  expect(NAV_SECTIONS.map((s) => s.label)).toEqual([
    "Nodes",
    "Workloads",
    "Config",
    "Network",
    "Storage",
    "Namespaces",
    "Events",
    "Access Control",
    "Custom Resources",
  ]);
  expect(visibleSections(allServed())).toEqual(NAV_SECTIONS);
});

test("items not served are hidden", () => {
  const served = allServed().filter((r) => r.resource.plural !== "cronjobs");
  const workloads = visibleSections(served).find((s) => s.id === "workloads");
  expect(workloads?.items.map((i) => i.plural)).not.toContain("cronjobs");
  expect(workloads?.items.map((i) => i.plural)).toContain("jobs");
});

test("items the user cannot list are hidden", () => {
  const served = allServed().map((r) =>
    r.resource.plural === "secrets" ? { ...r, canList: false } : r,
  );
  const config = visibleSections(served).find((s) => s.id === "config");
  expect(config?.items.map((i) => i.plural)).not.toContain("secrets");
  expect(config?.items.map((i) => i.plural)).toContain("configmaps");
});

test("sections with no visible items disappear", () => {
  const sections = visibleSections([
    info("", "pods"),
    info("", "nodes", { canList: false }),
  ]);
  expect(sections.map((s) => s.id)).toEqual(["workloads"]);
  expect(visibleSections([])).toEqual([]);
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
