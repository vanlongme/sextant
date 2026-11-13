import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  defaultLayout,
  type WorkspaceLayout,
} from "../features/workspace/layout";
import { clusterEntry, flush, mockBackend } from "../test/ipc";
import { connectClusters, setClusterState } from "../test/terminal";
import { resetCatalogForTest, useCatalog } from "./catalog";
import {
  openInWorkspace,
  resetWorkspaceForTest,
  restoreWorkspace,
  useWorkspace,
  WORKSPACE_KEY,
} from "./workspace";

const SAVED: WorkspaceLayout = {
  version: 1,
  panes: [
    {
      id: "p1",
      tabs: [{ id: "t1", clusterId: "a", view: "pods", pinned: true }],
      active: "t1",
    },
    {
      id: "p2",
      tabs: [{ id: "t2", clusterId: "b", view: "events", pinned: false }],
      active: "t2",
    },
  ],
  focus: "p2",
  widths: [0.6, 0.4],
  seq: 5,
};

beforeEach(() => {
  resetCatalogForTest();
  resetWorkspaceForTest();
});

afterEach(() => {
  vi.useRealTimers();
});

test("the saved layout is read once, under the key workspace", async () => {
  const backend = mockBackend({
    ui_state_get: () => SAVED,
    ui_state_set: () => null,
  });

  expect(useWorkspace.getState().restored).toBe(false);
  await restoreWorkspace();
  await restoreWorkspace();

  expect(backend.callsTo("ui_state_get")).toEqual([{ key: WORKSPACE_KEY }]);
  expect(useWorkspace.getState()).toMatchObject({
    restored: true,
    layout: SAVED,
  });
});

test("a bad saved value or a failed read gives the default layout", async () => {
  mockBackend({
    ui_state_get: () => ({ ...SAVED, version: 2 }),
    ui_state_set: () => null,
  });
  await restoreWorkspace();
  expect(useWorkspace.getState().layout).toEqual(defaultLayout());

  resetWorkspaceForTest();
  mockBackend({
    ui_state_get: () => {
      throw { code: "Internal", message: "unreadable", details: null };
    },
  });
  await restoreWorkspace();
  expect(useWorkspace.getState()).toMatchObject({
    restored: true,
    layout: defaultLayout(),
  });
});

test("a change is saved 300 ms after the last one", async () => {
  const backend = mockBackend({
    ui_state_get: () => null,
    ui_state_set: () => null,
  });
  await restoreWorkspace();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { dispatch } = useWorkspace.getState();

  dispatch({ type: "open", clusterId: "a", side: false, view: "pods" });
  vi.advanceTimersByTime(200);
  dispatch({ type: "open", clusterId: "b", side: true, view: "pods" });
  vi.advanceTimersByTime(299);
  expect(backend.callsTo("ui_state_set")).toEqual([]);
  vi.advanceTimersByTime(1);

  expect(backend.callsTo("ui_state_set")).toEqual([
    { key: WORKSPACE_KEY, value: useWorkspace.getState().layout },
  ]);
  expect(useWorkspace.getState().layout.panes).toHaveLength(2);
});

test("an action that changes nothing saves nothing, and pagehide saves at once", async () => {
  const backend = mockBackend({
    ui_state_get: () => null,
    ui_state_set: () => null,
  });
  await restoreWorkspace();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { dispatch } = useWorkspace.getState();

  dispatch({ type: "focus", paneId: "p1" });
  vi.advanceTimersByTime(1000);
  expect(backend.callsTo("ui_state_set")).toEqual([]);

  dispatch({ type: "open", clusterId: "a", side: false, view: "pods" });
  window.dispatchEvent(new Event("pagehide"));
  expect(backend.callsTo("ui_state_set")).toHaveLength(1);
  vi.advanceTimersByTime(1000);
  expect(backend.callsTo("ui_state_set")).toHaveLength(1);
});

test("tabs of clusters gone from the catalog are pruned once it has loaded, and on every change", async () => {
  mockBackend({ ui_state_get: () => SAVED, ui_state_set: () => null });
  // Still loading: nothing is pruned against an empty list.
  await restoreWorkspace();
  expect(useWorkspace.getState().layout).toEqual(SAVED);

  connectClusters({ id: "a", name: "alpha" }, { id: "b", name: "beta" });
  expect(useWorkspace.getState().layout).toEqual(SAVED);

  useCatalog.setState({
    clusters: [clusterEntry({ id: "a", contextName: "alpha" })],
  });
  expect(useWorkspace.getState().layout.panes.map((p) => p.id)).toEqual(["p1"]);
  expect(useWorkspace.getState().layout.focus).toBe("p1");
});

test("a failed catalog load prunes nothing", async () => {
  mockBackend({ ui_state_get: () => SAVED, ui_state_set: () => null });
  useCatalog.setState({ loading: false, error: "boom", clusters: [] });

  await restoreWorkspace();

  expect(useWorkspace.getState().layout).toEqual(SAVED);
});

test("openInWorkspace waits for the saved layout and opens a Failed cluster on its Overview", async () => {
  mockBackend({ ui_state_get: () => SAVED, ui_state_set: () => null });
  connectClusters(
    { id: "a", name: "alpha" },
    { id: "b", name: "beta" },
    { id: "c", name: "gamma" },
  );
  setClusterState("c", {
    status: "failed",
    kind: "unreachable",
    message: "connection refused",
  });

  await openInWorkspace("c", true);

  const { layout } = useWorkspace.getState();
  expect(layout.panes.map((p) => p.tabs.map((t) => t.clusterId))).toEqual([
    ["a"],
    ["b"],
    ["c"],
  ]);
  expect(layout.panes[2].tabs[0].view).toBe("overview");
  expect(layout.focus).toBe(layout.panes[2].id);
});

test("openInWorkspace opens any other cluster on its Pods, in the focused pane without side", async () => {
  mockBackend({ ui_state_get: () => null, ui_state_set: () => null });
  connectClusters({ id: "a", name: "alpha" });

  await openInWorkspace("a", false);
  await flush();

  expect(useWorkspace.getState().layout.panes[0].tabs).toEqual([
    { id: "t2", clusterId: "a", view: "pods", pinned: false },
  ]);
});

test("setNamespace keeps a namespace per tab", () => {
  const { setNamespace } = useWorkspace.getState();

  setNamespace("t1", "shop");
  setNamespace("t2", null);

  expect(useWorkspace.getState().namespaces).toEqual({ t1: "shop", t2: null });
});
