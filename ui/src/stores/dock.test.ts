import { afterEach, expect, test, vi } from "vitest";
import type { ResourceRef } from "../ipc/generated/ResourceRef";
import { JOBS } from "../kinds/refs";
import {
  type DockLayout,
  type DockTab,
  editTab,
  isPodTab,
  type LogsDockTab,
  logsTab,
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

test("a Logs tab on a Pod reads its first container; one on a workload reads them all", () => {
  const pod = logsTab("c1", PODS, {
    metadata: { name: "web-1", namespace: "shop" },
    spec: { containers: [{ name: "app" }, { name: "proxy" }] },
  });
  expect(pod).toEqual({
    id: "logs:c1:/pods:shop/web-1",
    kind: "logs",
    clusterId: "c1",
    title: "Logs · web-1",
    resource: PODS,
    namespace: "shop",
    name: "web-1",
    options: {
      pod: "all",
      container: "app",
      tail: 1000,
      follow: true,
      previous: false,
      timestamps: true,
      wrap: false,
    },
    dirty: false,
  });
  expect(isPodTab(pod)).toBe(true);
  const job = logsTab("c1", JOBS, {
    metadata: { name: "nightly", namespace: "ops" },
  });
  expect(job.id).toBe("logs:c1:batch/jobs:ops/nightly");
  expect(job.options.container).toBeNull();
  expect(isPodTab(job)).toBe(false);
});

test("setLogOptions changes one Logs tab's options and keeps the rest", () => {
  const a = logsTab("c1", JOBS, { metadata: { name: "a", namespace: "n" } });
  const b = logsTab("c1", JOBS, { metadata: { name: "b", namespace: "n" } });
  dock().open(a);
  dock().open(b);
  dock().setLogOptions(a.id, { tail: 100, wrap: true });
  const [first, second] = dock().tabs as LogsDockTab[];
  expect(first?.options).toEqual({ ...a.options, tail: 100, wrap: true });
  expect(second?.options).toEqual(b.options);
});

test("setDirty leaves a Logs tab clean", () => {
  const tab = logsTab("c1", JOBS, { metadata: { name: "a", namespace: "n" } });
  dock().open(tab);
  dock().setDirty(tab.id, true);
  expect(dock().tabs[0]?.dirty).toBe(false);
});

const A = editTab("c1", PODS, "n", "a");
const B = editTab("c1", PODS, "n", "b");
const C = editTab("c1", PODS, "n", "c");
const OTHER = editTab("c2", PODS, "n", "o");

function layout(tabs: DockTab[], over: Partial<DockLayout> = {}): DockLayout {
  return { height: 400, minimized: true, activeId: null, tabs, ...over };
}

test("restore applies the saved layout", () => {
  useDock.setState({ restored: false });
  dock().restore(layout([A, B], { activeId: B.id }));
  expect(ids(dock().tabs)).toEqual([A.id, B.id]);
  expect(dock()).toMatchObject({
    activeId: B.id,
    minimized: true,
    height: 400,
    restored: true,
  });
});

test("tabs opened before the layout arrived stay after the saved ones, and stay active", () => {
  useDock.setState({ restored: false });
  dock().open(C);
  dock().restore(layout([A, C], { activeId: A.id }));
  expect(ids(dock().tabs)).toEqual([A.id, C.id]);
  expect(dock()).toMatchObject({ activeId: C.id, minimized: false });

  resetDockForTest();
  useDock.setState({ restored: false });
  dock().open(C);
  dock().restore(layout([A], { activeId: A.id }));
  expect(ids(dock().tabs)).toEqual([A.id, C.id]);
});

test("the create counter starts above the highest restored create tab", () => {
  const create = (n: number): DockTab => ({
    id: `create-${n}`,
    kind: "create",
    clusterId: "c1",
    title: "Create",
    dirty: false,
  });
  dock().restore(layout([create(7), create(3)]));
  expect(newCreateTab("c1").id).toBe("create-8");
});

test("keepClusters drops the tabs and drafts of other clusters", () => {
  dock().open(A);
  dock().open(OTHER);
  writeDraft(OTHER.id, "kind: Pod");
  dock().keepClusters(["c1"]);
  expect(ids(dock().tabs)).toEqual([A.id]);
  expect(dock().activeId).toBeNull();
  expect(readDraft(OTHER.id)).toBeUndefined();
});

test("move reorders a tab among its cluster's tabs, and other clusters keep their places", () => {
  for (const tab of [A, OTHER, B, C]) dock().open(tab);
  dock().move(A.id, 2);
  expect(ids(dock().tabs)).toEqual([B.id, OTHER.id, C.id, A.id]);
  dock().move(A.id, -5);
  expect(ids(dock().tabs)).toEqual([A.id, OTHER.id, B.id, C.id]);
  const before = dock().tabs;
  dock().move(C.id, 99);
  expect(dock().tabs).toBe(before);
});
