import { act, renderHook } from "@testing-library/react";
import { expect, test } from "vitest";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import type { KubeObject } from "../../kinds/objects";
import { rootTarget, useDrawerHistory } from "./useDrawerHistory";

const PODS: ResourceRef = {
  group: "",
  version: "v1",
  plural: "pods",
  kind: "Pod",
  namespaced: true,
};
const node = { group: "", plural: "nodes", namespace: null, name: "n1" };
const object = (name: string): KubeObject => ({ metadata: { name } });

test("rootTarget reads the object param, with no namespace for a cluster-scoped key", () => {
  expect(rootTarget(PODS, "team-a/web")).toEqual({
    group: "",
    plural: "pods",
    namespace: "team-a",
    name: "web",
  });
  expect(rootTarget({ group: "", plural: "nodes" }, "/n1")).toEqual({
    group: "",
    plural: "nodes",
    namespace: null,
    name: "n1",
  });
  expect(rootTarget(PODS, null)).toBeNull();
});

test("open pushes, back pops, and the shown entry carries its tab", () => {
  const { result } = renderHook(() => useDrawerHistory(PODS, "team-a/web"));
  expect(result.current.shown?.target.name).toBe("web");
  expect(result.current.previous).toBeNull();
  act(() => result.current.setTab("events"));
  act(() => result.current.open(node));
  expect(result.current.shown?.target).toEqual(node);
  expect(result.current.previous?.target.name).toBe("web");
  act(() => result.current.back());
  expect(result.current.shown).toEqual({
    target: rootTarget(PODS, "team-a/web"),
    tab: "events",
  });
});

test("a new object param restarts the history at its root", () => {
  const { result, rerender } = renderHook(
    ({ key }: { key: string | null }) => useDrawerHistory(PODS, key),
    { initialProps: { key: "team-a/web" as string | null } },
  );
  act(() => result.current.open(node));
  rerender({ key: "team-a/db" });
  expect(result.current.shown?.target.name).toBe("db");
  expect(result.current.previous).toBeNull();
  rerender({ key: null });
  expect(result.current.shown).toBeNull();
  expect(result.current.root).toBeNull();
});

test("reset returns to the root", () => {
  const { result } = renderHook(() => useDrawerHistory(PODS, "team-a/web"));
  act(() => result.current.open(node));
  act(() => result.current.reset());
  expect(result.current.shown?.target.name).toBe("web");
  expect(result.current.previous).toBeNull();
});

test("open and back count steps; reset and a new root do not", () => {
  const { result, rerender } = renderHook(
    ({ key }: { key: string }) => useDrawerHistory(PODS, key),
    { initialProps: { key: "team-a/web" } },
  );
  expect(result.current.step).toBe(0);
  act(() => result.current.open(node));
  act(() => result.current.back());
  expect(result.current.step).toBe(2);
  act(() => result.current.reset());
  rerender({ key: "team-a/db" });
  expect(result.current.step).toBe(2);
});

test("the last object seen is kept per entry and dropped with its entry", () => {
  const { result } = renderHook(() => useDrawerHistory(PODS, "team-a/web"));
  const root = result.current.root;
  if (root === null) throw new Error("no root");
  act(() => result.current.remember(root, object("web")));
  act(() => result.current.open(node));
  act(() => result.current.remember(node, object("n1")));
  expect(result.current.lastSeen(root)?.metadata.name).toBe("web");
  expect(result.current.lastSeen(node)?.metadata.name).toBe("n1");
  act(() => result.current.back());
  act(() => result.current.remember(root, object("web")));
  expect(result.current.lastSeen(node)).toBeNull();
  expect(result.current.lastSeen(root)?.metadata.name).toBe("web");
});
