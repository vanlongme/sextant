import { afterEach, expect, test, vi } from "vitest";
import type { ResourceRef } from "../ipc/generated/ResourceRef";
import {
  type DockTab,
  editTab,
  newCreateTab,
  readDraft,
  resetDockForTest,
  tabsForCluster,
  useDock,
  writeDraft,
} from "./dock";

const PODS: ResourceRef = {
  group: "",
  version: "v1",
  plural: "pods",
  kind: "Pod",
  namespaced: true,
};

function dock() {
  return useDock.getState();
}

function ids(tabs: DockTab[]): string[] {
  return tabs.map((t) => t.id);
}

afterEach(() => {
  resetDockForTest();
  vi.unstubAllGlobals();
});

test("opening the same object twice focuses one tab", () => {
  const first = editTab("c1", PODS, "team-a", "web");
  dock().open(first);
  dock().open(newCreateTab("c1"));
  expect(dock().tabs).toHaveLength(2);
  expect(dock().activeId).not.toBe(first.id);

  // A different API version of the same object is still the same object.
  dock().open({
    ...editTab("c1", { ...PODS, version: "v2" }, "team-a", "web"),
    id: "another-id",
  });

  expect(dock().tabs).toHaveLength(2);
  expect(dock().activeId).toBe(first.id);
});

test("objects that differ in cluster, namespace or type get their own tab", () => {
  dock().open(editTab("c1", PODS, "team-a", "web"));
  dock().open(editTab("c2", PODS, "team-a", "web"));
  dock().open(editTab("c1", PODS, "team-b", "web"));
  dock().open(editTab("c1", { ...PODS, plural: "services" }, "team-a", "web"));
  expect(new Set(ids(dock().tabs)).size).toBe(4);
});

test("opening a tab shows the dock again", () => {
  dock().setMinimized(true);
  dock().open(newCreateTab("c1"));
  expect(dock().minimized).toBe(false);
});

test("closing the active tab selects a neighbour", () => {
  const [a, b, c] = ["a", "b", "c"].map((n) => editTab("c1", PODS, "x", n));
  dock().open(a);
  dock().open(b);
  dock().open(c);

  dock().activate(b.id);
  dock().close(b.id);
  expect(dock().activeId).toBe(c.id);

  dock().close(c.id);
  expect(dock().activeId).toBe(a.id);

  dock().close(a.id);
  expect(dock().activeId).toBeNull();
  expect(dock().tabs).toEqual([]);
});

test("closing the active tab never selects another cluster's tab", () => {
  const other = editTab("c2", PODS, "x", "other");
  const mine = editTab("c1", PODS, "x", "mine");
  dock().open(other);
  dock().open(mine);

  dock().close(mine.id);

  expect(dock().activeId).toBeNull();
  expect(ids(dock().tabs)).toEqual([other.id]);
});

test("closing another tab leaves the active one alone", () => {
  const a = editTab("c1", PODS, "x", "a");
  const b = editTab("c1", PODS, "x", "b");
  dock().open(a);
  dock().open(b);
  dock().close(a.id);
  expect(dock().activeId).toBe(b.id);
});

test("tabsForCluster isolates clusters", () => {
  const one = editTab("c1", PODS, "x", "web");
  const two = editTab("c2", PODS, "x", "web");
  const create = newCreateTab("c2");
  dock().open(one);
  dock().open(two);
  dock().open(create);

  expect(ids(tabsForCluster(dock().tabs, "c1"))).toEqual([one.id]);
  expect(ids(tabsForCluster(dock().tabs, "c2"))).toEqual([two.id, create.id]);
  expect(tabsForCluster(dock().tabs, "c3")).toEqual([]);
});

test("height clamps between 120 px and 80% of the window", () => {
  vi.stubGlobal("innerHeight", 1000);

  dock().setHeight(50);
  expect(dock().height).toBe(120);
  dock().setHeight(500);
  expect(dock().height).toBe(500);
  dock().setHeight(5000);
  expect(dock().height).toBe(800);
});

test("setDirty marks one tab", () => {
  const a = editTab("c1", PODS, "x", "a");
  const b = editTab("c1", PODS, "x", "b");
  dock().open(a);
  dock().open(b);

  dock().setDirty(a.id, true);

  expect(dock().tabs.map((t) => t.dirty)).toEqual([true, false]);
});

test("each new create tab is its own tab", () => {
  dock().open(newCreateTab("c1"));
  dock().open(newCreateTab("c1"));
  expect(dock().tabs).toHaveLength(2);
});

test("a draft lasts until its tab closes", () => {
  const tab = newCreateTab("c1");
  dock().open(tab);
  writeDraft(tab.id, "kept");
  expect(readDraft<string>(tab.id)).toBe("kept");

  dock().close(tab.id);
  expect(readDraft<string>(tab.id)).toBeUndefined();

  writeDraft(tab.id, "too late");
  expect(readDraft<string>(tab.id)).toBeUndefined();
});
