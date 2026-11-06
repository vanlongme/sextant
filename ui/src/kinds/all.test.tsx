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
