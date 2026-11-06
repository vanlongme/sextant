import { render } from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, test } from "vitest";
import type { ApiResourceInfo } from "../ipc/generated/ApiResourceInfo";
import { resetResourcesForTest } from "../stores/resources";
import { flush, mockBackend } from "../test/ipc";
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
      "cells and panel survive a sparse object (%#)",
      async (object) => {
        const info = infoFor(group, plural);
        const cells = spec.columns?.(info).map((c) => {
          c.sortValue?.(object);
          return <div key={c.id}>{c.render(object)}</div>;
        });
        render(
          <MemoryRouter>
            {cells}
            {spec.detail
              ? createElement(spec.detail, {
                  clusterId: "c",
                  object,
                  resource: info.resource,
                  resources: [info],
                })
              : null}
          </MemoryRouter>,
        );
        await flush();
      },
    );
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
    "autoscaling/horizontalpodautoscalers",
    "batch/cronjobs",
    "batch/jobs",
    "coordination.k8s.io/leases",
    "discovery.k8s.io/endpointslices",
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
