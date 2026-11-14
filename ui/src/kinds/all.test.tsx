import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { OverviewSections } from "../features/details/OverviewSections";
import type { ApiResourceInfo } from "../ipc/generated/ApiResourceInfo";
import { resetResourcesForTest } from "../stores/resources";
import { flush, mockBackend } from "../test/ipc";
import { DrawerLinkContext } from "./detail/links";
import "./index";
import type { KubeObject } from "./objects";
import { registeredKinds } from "./registry";

const SPARSE: KubeObject[] = [
  { metadata: { name: "x" } },
  { metadata: { name: "x", namespace: "n" }, spec: {}, status: {} },
  {
    metadata: { name: "x", namespace: "n" },
    spec: { containers: [] },
    status: { conditions: [] },
  },
];

function infoFor(group: string, plural: string): ApiResourceInfo {
  return {
    resource: { group, version: "v1", plural, kind: plural, namespaced: true },
    verbs: [],
    shortNames: [],
    canList: true,
    canWatch: true,
    canCreate: true,
    canUpdate: true,
    canPatch: true,
    canDelete: true,
  };
}

/** An object with a namespace and a controller, the links every kind's Overview draws. */
const LINKED: KubeObject = {
  metadata: {
    name: "x",
    namespace: "n",
    ownerReferences: [
      {
        apiVersion: "v1",
        kind: "ConfigMap",
        name: "owner",
        uid: "u1",
        controller: true,
      },
    ],
  },
  spec: {},
  status: {},
};

const NAMESPACES: ApiResourceInfo = {
  ...infoFor("", "namespaces"),
  resource: {
    group: "",
    version: "v1",
    plural: "namespaces",
    kind: "Namespace",
    namespaced: false,
  },
};
const CONFIGMAPS: ApiResourceInfo = {
  ...infoFor("", "configmaps"),
  resource: {
    group: "",
    version: "v1",
    plural: "configmaps",
    kind: "ConfigMap",
    namespaced: true,
  },
};

beforeEach(() => {
  resetResourcesForTest();
  mockBackend({
    resources_subscribe: () => "s",
    resources_unsubscribe: () => null,
    resource_events: () => [],
  });
});

test("the registry can be read", () => {
  expect(Array.isArray(registeredKinds())).toBe(true);
});

describe.each(registeredKinds())(
  "$group/$plural",
  ({ group, plural, spec }) => {
    test.each(SPARSE)(
      "cells and the Overview survive a sparse object (%#)",
      async (object) => {
        const info = infoFor(group, plural);
        const columns = spec.columns?.(info) ?? [];
        const cells = columns.map((c) => {
          c.sortValue?.(object);
          return <div key={c.id}>{c.render(object)}</div>;
        });
        render(
          <MemoryRouter>
            {cells}
            <OverviewSections
              clusterId="c"
              resource={info.resource}
              object={object}
              resources={[info]}
              columns={columns}
            />
          </MemoryRouter>,
        );
        await flush();
      },
    );

    test("inside a drawer, its Overview's links open there and never route to a list", async () => {
      const info = infoFor(group, plural);
      const open = vi.fn();
      const { container } = render(
        <MemoryRouter>
          <DrawerLinkContext.Provider value={{ open }}>
            <OverviewSections
              clusterId="c"
              resource={info.resource}
              object={LINKED}
              resources={[info, NAMESPACES, CONFIGMAPS]}
              columns={spec.columns?.(info) ?? []}
            />
          </DrawerLinkContext.Provider>
        </MemoryRouter>,
      );
      await flush();
      expect(container.querySelectorAll('a[href*="object="]')).toHaveLength(0);
      const targets = [
        ...container.querySelectorAll<HTMLElement>("button[data-target]"),
      ].map((b) => b.dataset.target);
      expect(targets).toContain("/namespaces//n");
      expect(targets).toContain("/configmaps/n/owner");
    });
  },
);

test("every kind of the plan is registered", () => {
  const registered = registeredKinds()
    .map((k) => `${k.group}/${k.plural}`)
    .sort();
  expect(registered).toEqual([
    "/configmaps",
    "/events",
    "/limitranges",
    "/namespaces",
    "/nodes",
    "/persistentvolumeclaims",
    "/persistentvolumes",
    "/pods",
    "/resourcequotas",
    "/secrets",
    "/serviceaccounts",
    "/services",
    "admissionregistration.k8s.io/mutatingwebhookconfigurations",
    "admissionregistration.k8s.io/validatingwebhookconfigurations",
    "apiextensions.k8s.io/customresourcedefinitions",
    "apps/daemonsets",
    "apps/deployments",
    "apps/replicasets",
    "apps/statefulsets",
    "argoproj.io/applications",
    "argoproj.io/applicationsets",
    "argoproj.io/appprojects",
    "autoscaling/horizontalpodautoscalers",
    "batch/cronjobs",
    "batch/jobs",
    "coordination.k8s.io/leases",
    "discovery.k8s.io/endpointslices",
    "gateway.networking.k8s.io/gatewayclasses",
    "gateway.networking.k8s.io/gateways",
    "gateway.networking.k8s.io/httproutes",
    "networking.k8s.io/ingressclasses",
    "networking.k8s.io/ingresses",
    "networking.k8s.io/networkpolicies",
    "node.k8s.io/runtimeclasses",
    "policy/poddisruptionbudgets",
    "rbac.authorization.k8s.io/clusterrolebindings",
    "rbac.authorization.k8s.io/clusterroles",
    "rbac.authorization.k8s.io/rolebindings",
    "rbac.authorization.k8s.io/roles",
    "scheduling.k8s.io/priorityclasses",
    "storage.k8s.io/storageclasses",
  ]);
});
