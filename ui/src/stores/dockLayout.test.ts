import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ResourceRef } from "../ipc/generated/ResourceRef";
import type { JsonValue } from "../ipc/generated/serde_json/JsonValue";
import { DEPLOYMENTS, PODS } from "../kinds/refs";
import { clusterEntry, mockBackend } from "../test/ipc";
import { resetCatalogForTest, useCatalog } from "./catalog";
import {
  type DockTab,
  editTab,
  logsTab,
  resetDockForTest,
  useDock,
  writeDraft,
} from "./dock";
import {
  DOCK_LAYOUT_KEY,
  LAYOUT_SAVE_DELAY_MS,
  parseLayout,
  resetDockLayoutForTest,
  restoreDockLayout,
  serializeLayout,
} from "./dockLayout";

const NODES: ResourceRef = {
  group: "",
  version: "v1",
  plural: "nodes",
  kind: "Node",
  namespaced: false,
};

const EDIT = editTab("c1", PODS, "team-a", "web");
const CLUSTER_EDIT = editTab("c1", NODES, undefined, "node-1");
const CREATE: DockTab = {
  id: "create-4",
  kind: "create",
  clusterId: "c1",
  title: "Create",
  dirty: false,
};
const LOGS = logsTab("c2", DEPLOYMENTS, {
  metadata: { name: "api", namespace: "shop" },
});

const SAVED_EDIT = {
  id: EDIT.id,
  kind: "edit",
  clusterId: "c1",
  resource: PODS,
  namespace: "team-a",
  name: "web",
};
const SAVED_CLUSTER_EDIT = {
  id: CLUSTER_EDIT.id,
  kind: "edit",
  clusterId: "c1",
  resource: NODES,
  namespace: null,
  name: "node-1",
};
const SAVED_CREATE = { id: "create-4", kind: "create", clusterId: "c1" };
const SAVED_LOGS = {
  id: LOGS.id,
  kind: "logs",
  clusterId: "c2",
  resource: DEPLOYMENTS,
  namespace: "shop",
  name: "api",
  options: LOGS.options,
};

function saved(
  tabs: JsonValue[],
  over: { [key: string]: JsonValue } = {},
): JsonValue {
  return {
    version: 1,
    height: 400,
    minimized: false,
    activeId: null,
    tabs,
    ...over,
  };
}

const ids = () => useDock.getState().tabs.map((t) => t.id);

beforeEach(() => {
  vi.stubGlobal("innerHeight", 1000);
  resetCatalogForTest();
  resetDockForTest();
  useDock.setState({ restored: false });
});

afterEach(() => {
  resetDockLayoutForTest();
  resetDockForTest();
  resetCatalogForTest();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test.each<[string, JsonValue | null]>([
  ["nothing saved", null],
  ["a value that is not an object", "dock"],
  ["another version", saved([], { version: 2 })],
  ["tabs that are not a list", saved([], { tabs: "none" })],
  ["a height that is not a number", saved([], { height: "tall" })],
  ["a minimized that is not a boolean", saved([], { minimized: "no" })],
  ["an activeId that is not a string", saved([], { activeId: 3 })],
])("%s gives the defaults", (_name, value) => {
  expect(parseLayout(value)).toEqual({
    height: 320,
    minimized: false,
    activeId: null,
    tabs: [],
  });
});

test("each tab kind comes back with its title and clean", () => {
  expect(
    parseLayout(
      saved([SAVED_EDIT, SAVED_CLUSTER_EDIT, SAVED_CREATE, SAVED_LOGS], {
        activeId: LOGS.id,
        minimized: true,
      }),
    ),
  ).toEqual({
    height: 400,
    minimized: true,
    activeId: LOGS.id,
    tabs: [EDIT, CLUSTER_EDIT, CREATE, LOGS],
  });
});

test("a malformed tab is dropped alone, and so is a second tab with the same id", () => {
  const layout = parseLayout(
    saved([
      SAVED_EDIT,
      { ...SAVED_EDIT, id: "edit:c1:/pods:team-a/other" },
      { ...SAVED_EDIT, resource: { group: "", plural: "pods" } },
      { ...SAVED_LOGS, options: { ...LOGS.options, tail: 50 } },
      { ...SAVED_LOGS, namespace: "" },
      { id: "create-x", kind: "create", clusterId: "c1" },
      { id: "terminal-1", kind: "terminal", clusterId: "c1" },
      "edit",
      SAVED_EDIT,
      SAVED_LOGS,
    ]),
  );
  expect(layout.tabs).toEqual([EDIT, LOGS]);
});

test("the height is clamped, and an activeId that names no tab becomes null", () => {
  expect(parseLayout(saved([], { height: 50 })).height).toBe(120);
  expect(parseLayout(saved([], { height: 5000 })).height).toBe(800);
  expect(
    parseLayout(saved([SAVED_EDIT], { activeId: "edit:c1:/pods:team-a/gone" }))
      .activeId,
  ).toBeNull();
});

test("a saved layout reads back as it was, without titles or dirty marks", () => {
  useDock.setState({
    tabs: [EDIT, CLUSTER_EDIT, CREATE, LOGS],
    activeId: CREATE.id,
    height: 444,
    minimized: true,
  });
  const written = JSON.parse(
    JSON.stringify(serializeLayout(useDock.getState())),
  );
  expect(written.tabs).toEqual([
    SAVED_EDIT,
    SAVED_CLUSTER_EDIT,
    SAVED_CREATE,
    SAVED_LOGS,
  ]);
  expect(parseLayout(written)).toEqual({
    height: 444,
    minimized: true,
    activeId: CREATE.id,
    tabs: [EDIT, CLUSTER_EDIT, CREATE, LOGS],
  });
});

test("restore reads the key once and applies it", async () => {
  const b = mockBackend({
    ui_state_get: () => saved([SAVED_EDIT], { activeId: EDIT.id }),
    ui_state_set: () => null,
  });
  await Promise.all([restoreDockLayout(), restoreDockLayout()]);
  expect(b.callsTo("ui_state_get")).toEqual([{ key: DOCK_LAYOUT_KEY }]);
  expect(useDock.getState()).toMatchObject({
    restored: true,
    height: 400,
    activeId: EDIT.id,
    tabs: [EDIT],
  });
});

test("a layout that cannot be read gives the defaults", async () => {
  mockBackend({
    ui_state_get: () => {
      throw { code: "Internal", message: "broken", details: null };
    },
  });
  useDock.setState({ height: 500 });
  await restoreDockLayout();
  expect(useDock.getState()).toMatchObject({
    restored: true,
    height: 320,
    minimized: false,
    tabs: [],
  });
});

test("changes are written 300 ms after the last one", async () => {
  vi.useFakeTimers();
  const b = mockBackend({ ui_state_get: () => null, ui_state_set: () => null });
  await restoreDockLayout();

  useDock.getState().setHeight(400);
  useDock.getState().open(EDIT);
  vi.advanceTimersByTime(LAYOUT_SAVE_DELAY_MS - 1);
  expect(b.callsTo("ui_state_set")).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(b.callsTo("ui_state_set")).toEqual([
    {
      key: DOCK_LAYOUT_KEY,
      value: {
        version: 1,
        height: 400,
        minimized: false,
        activeId: EDIT.id,
        tabs: [SAVED_EDIT],
      },
    },
  ]);
});

test("a change to a field that is not saved writes nothing", async () => {
  vi.useFakeTimers();
  const b = mockBackend({ ui_state_get: () => null, ui_state_set: () => null });
  await restoreDockLayout();
  useDock.getState().open(EDIT);
  vi.advanceTimersByTime(LAYOUT_SAVE_DELAY_MS);
  expect(b.callsTo("ui_state_set")).toHaveLength(1);

  useDock.getState().setDirty(EDIT.id, true);
  writeDraft(EDIT.id, "kind: Pod");
  vi.advanceTimersByTime(LAYOUT_SAVE_DELAY_MS);
  expect(b.callsTo("ui_state_set")).toHaveLength(1);
});

test("pagehide writes a pending change at once, and only once", async () => {
  vi.useFakeTimers();
  const b = mockBackend({ ui_state_get: () => null, ui_state_set: () => null });
  await restoreDockLayout();

  useDock.getState().setMinimized(true);
  window.dispatchEvent(new Event("pagehide"));
  expect(b.callsTo("ui_state_set")).toHaveLength(1);
  expect(b.callsTo("ui_state_set")[0]).toMatchObject({
    value: { minimized: true },
  });
  vi.advanceTimersByTime(LAYOUT_SAVE_DELAY_MS);
  window.dispatchEvent(new Event("pagehide"));
  expect(b.callsTo("ui_state_set")).toHaveLength(1);
});

test("a failed write is ignored, and the next change is written", async () => {
  vi.useFakeTimers();
  const b = mockBackend({
    ui_state_get: () => null,
    ui_state_set: () => {
      throw { code: "Internal", message: "disk full", details: null };
    },
  });
  await restoreDockLayout();

  useDock.getState().setHeight(400);
  vi.advanceTimersByTime(LAYOUT_SAVE_DELAY_MS);
  await Promise.resolve();
  useDock.getState().setHeight(500);
  vi.advanceTimersByTime(LAYOUT_SAVE_DELAY_MS);
  expect(b.callsTo("ui_state_set")).toHaveLength(2);
});

test("tabs of clusters the catalog does not know are dropped once it has loaded", async () => {
  mockBackend({
    ui_state_get: () => saved([SAVED_EDIT, SAVED_LOGS]),
    ui_state_set: () => null,
  });
  await restoreDockLayout();
  expect(ids()).toEqual([EDIT.id, LOGS.id]);

  useCatalog.setState({ loading: false, error: "cannot read the kubeconfigs" });
  expect(ids()).toEqual([EDIT.id, LOGS.id]);

  useCatalog.setState({
    loading: false,
    error: null,
    clusters: [clusterEntry({ id: "c1" })],
  });
  expect(ids()).toEqual([EDIT.id]);

  // Once only: a cluster that goes away later keeps its tabs.
  useDock.getState().open(LOGS);
  useCatalog.setState({ clusters: [] });
  expect(ids()).toEqual([EDIT.id, LOGS.id]);
});

test("a catalog that has already loaded is applied right after restore", async () => {
  useCatalog.setState({
    loading: false,
    error: null,
    clusters: [clusterEntry({ id: "c2" })],
  });
  mockBackend({
    ui_state_get: () => saved([SAVED_EDIT, SAVED_LOGS]),
    ui_state_set: () => null,
  });
  await restoreDockLayout();
  expect(ids()).toEqual([LOGS.id]);
});
