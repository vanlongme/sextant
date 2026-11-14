import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import { defaultColumns, registerKind } from "../../kinds/registry";
import { resetResourcesForTest } from "../../stores/resources";
import { mockBackend } from "../../test/ipc";
import { useKindColumns } from "./kindColumns";

function info(resource: ResourceRef): ApiResourceInfo {
  return {
    resource,
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

const LEASES = info({
  group: "coordination.k8s.io",
  version: "v1",
  plural: "leases",
  kind: "Lease",
  namespaced: true,
});
const THINGS = info({
  group: "test.skopos",
  version: "v1",
  plural: "things",
  kind: "Thing",
  namespaced: true,
});

beforeEach(() => resetResourcesForTest());
afterEach(() => {
  resetResourcesForTest();
  registerKind("test.skopos", "things", {});
});

test("no kind gives no columns and watches nothing", () => {
  const backend = mockBackend({});
  const { result } = renderHook(() =>
    useKindColumns("c1", undefined, [], null),
  );
  expect(result.current).toEqual([]);
  expect(backend.calls.filter((c) => c.cmd === "resources_subscribe")).toEqual(
    [],
  );
});

test("a built-in kind without its own columns gets the default ones", () => {
  mockBackend({});
  const { result } = renderHook(() =>
    useKindColumns("c1", LEASES, [LEASES], "n"),
  );
  expect(result.current.map((c) => c.id)).toEqual(
    defaultColumns(LEASES.resource).map((c) => c.id),
  );
});

test("a registered kind's columns win", () => {
  mockBackend({});
  registerKind("test.skopos", "things", {
    columns: (i) => [
      { id: "owner", header: i.resource.kind, width: 80, render: () => "x" },
    ],
  });
  const { result } = renderHook(() =>
    useKindColumns("c1", THINGS, [THINGS], null),
  );
  expect(result.current.map((c) => [c.id, c.header])).toEqual([
    ["owner", "Thing"],
  ]);
});
