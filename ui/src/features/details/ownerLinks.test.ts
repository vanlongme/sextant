import { expect, test } from "vitest";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import { ownerTarget } from "./ownerLinks";

function info(
  group: string,
  plural: string,
  kind: string,
  namespaced = true,
): ApiResourceInfo {
  return {
    resource: { group, version: "v1", plural, kind, namespaced },
    verbs: [],
    shortNames: [],
    canList: true,
    canWatch: true,
    canCreate: true,
    canUpdate: true,
    canDelete: true,
  };
}

const RESOURCES = [
  info("", "pods", "Pod"),
  info("apps", "replicasets", "ReplicaSet"),
  info("", "nodes", "Node", false),
];

test("an owner of a known kind gives the route with the object param", () => {
  expect(
    ownerTarget(
      { kind: "ReplicaSet", name: "web-1", apiVersion: "apps/v1" },
      "team-a",
      RESOURCES,
    ),
  ).toBe("/r/apps/replicasets?object=team-a%2Fweb-1");
});

test("the core group is spelled core, and a cluster-scoped owner has no namespace", () => {
  expect(
    ownerTarget(
      { kind: "Node", name: "n1", apiVersion: "v1" },
      "team-a",
      RESOURCES,
    ),
  ).toBe("/r/core/nodes?object=%2Fn1");
});

test("without an apiVersion the kind alone finds the owner", () => {
  expect(ownerTarget({ kind: "Pod", name: "p" }, "d", RESOURCES)).toBe(
    "/r/core/pods?object=d%2Fp",
  );
});

test("an owner of an unknown kind, or of another group, gives null", () => {
  expect(ownerTarget({ kind: "Widget", name: "w" }, "d", RESOURCES)).toBeNull();
  expect(
    ownerTarget(
      { kind: "Pod", name: "p", apiVersion: "other.io/v1" },
      "d",
      RESOURCES,
    ),
  ).toBeNull();
  expect(ownerTarget({ kind: "Pod", name: "p" }, "d", [])).toBeNull();
});
