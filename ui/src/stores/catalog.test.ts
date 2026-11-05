import { beforeEach, expect, test, vi } from "vitest";
import { toast } from "../design";
import type { ConnectionState } from "../ipc/generated/ConnectionState";
import { clusterEntry, emitEvent, flush, mockBackend } from "../test/ipc";
import { resetCatalogForTest, useCatalog } from "./catalog";

const alpha = clusterEntry({ id: "a", contextName: "alpha" });
const beta = clusterEntry({ id: "b", contextName: "beta" });

function backend(over: Record<string, (args: never) => unknown> = {}) {
  return mockBackend({
    catalog_list: () => [alpha, beta],
    catalog_warnings: () => [],
    hotbar_get: () => ["a"],
    hotbar_set: () => null,
    ...over,
  });
}

beforeEach(() => {
  resetCatalogForTest();
  vi.restoreAllMocks();
});

test("init loads clusters, warnings and hotbar", async () => {
  const warning = { path: "/k/config", message: "bad yaml" };
  backend({ catalog_warnings: () => [warning] });
  expect(useCatalog.getState().loading).toBe(true);

  await useCatalog.getState().init();

  const state = useCatalog.getState();
  expect(state.clusters.map((c) => c.id)).toEqual(["a", "b"]);
  expect(state.hotbar).toEqual(["a"]);
  expect(state.warnings).toEqual([warning]);
  expect(state.loading).toBe(false);
  expect(state.error).toBeNull();
});

test("pin appends and calls hotbar_set", async () => {
  const ipc = backend();
  await useCatalog.getState().init();

  await useCatalog.getState().pin("b");

  expect(useCatalog.getState().hotbar).toEqual(["a", "b"]);
  expect(ipc.callsTo("hotbar_set")).toEqual([{ ids: ["a", "b"] }]);
});

test("pin of a pinned cluster changes nothing", async () => {
  const ipc = backend();
  await useCatalog.getState().init();

  await useCatalog.getState().pin("a");

  expect(useCatalog.getState().hotbar).toEqual(["a"]);
  expect(ipc.callsTo("hotbar_set")).toEqual([]);
});

test("unpin removes and calls hotbar_set", async () => {
  const ipc = backend();
  await useCatalog.getState().init();

  await useCatalog.getState().unpin("a");

  expect(useCatalog.getState().hotbar).toEqual([]);
  expect(ipc.callsTo("hotbar_set")).toEqual([{ ids: [] }]);
});

test("a failed hotbar_set restores the previous order and raises a toast", async () => {
  const errors = vi.spyOn(toast, "error");
  backend({
    hotbar_get: () => ["a", "b"],
    hotbar_set: () => {
      throw { code: "Internal", message: "disk full", details: null };
    },
  });
  await useCatalog.getState().init();

  const pending = useCatalog.getState().reorderHotbar(["b", "a"]);
  expect(useCatalog.getState().hotbar).toEqual(["b", "a"]);
  await pending;

  expect(useCatalog.getState().hotbar).toEqual(["a", "b"]);
  expect(errors).toHaveBeenCalledTimes(1);
  expect(errors.mock.calls[0]?.join(" ")).toContain("disk full");
});

test("writes reach the backend in the order they were made", async () => {
  const landed: string[][] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  backend({
    hotbar_set: async (args: { ids: string[] }) => {
      if (args.ids.length === 2) await gate;
      landed.push(args.ids);
      return null;
    },
  });
  await useCatalog.getState().init();

  const first = useCatalog.getState().pin("b");
  const second = useCatalog.getState().unpin("a");
  await flush();
  expect(landed).toEqual([]);
  release();
  await Promise.all([first, second]);

  expect(landed).toEqual([["a", "b"], ["b"]]);
  expect(useCatalog.getState().hotbar).toEqual(["b"]);
});

test("init twice subscribes once", async () => {
  const ipc = backend();
  await Promise.all([
    useCatalog.getState().init(),
    useCatalog.getState().init(),
  ]);
  await useCatalog.getState().init();
  expect(ipc.callsTo("catalog_list")).toHaveLength(1);

  await emitEvent("catalog://changed");

  expect(ipc.callsTo("catalog_list")).toHaveLength(2);
});

test("catalog://changed reloads clusters and hotbar", async () => {
  let clusters = [alpha];
  let hotbar: string[] = [];
  backend({ catalog_list: () => clusters, hotbar_get: () => hotbar });
  await useCatalog.getState().init();

  clusters = [alpha, beta];
  hotbar = ["b"];
  await emitEvent("catalog://changed");

  expect(useCatalog.getState().clusters.map((c) => c.id)).toEqual(["a", "b"]);
  expect(useCatalog.getState().hotbar).toEqual(["b"]);
});

test("cluster://state updates the one entry", async () => {
  backend();
  await useCatalog.getState().init();

  await emitEvent("cluster://state", {
    id: "b",
    state: { status: "connecting" },
  });

  const state = useCatalog.getState();
  expect(state.clusters[0]?.state).toEqual({ status: "disconnected" });
  expect(state.clusters[1]?.state).toEqual({ status: "connecting" });
});

test("a state event during a reload is not lost to the older list", async () => {
  const connecting: ConnectionState = { status: "connecting" };
  let finishList: (value: unknown) => void = () => {};
  let list: () => unknown = () => [alpha, beta];
  backend({ catalog_list: () => list() });
  await useCatalog.getState().init();
  list = () =>
    new Promise((resolve) => {
      finishList = resolve;
    });

  await emitEvent("catalog://changed");
  await emitEvent("cluster://state", { id: "a", state: connecting });
  finishList([alpha, beta]);
  await flush();
  await flush();

  expect(useCatalog.getState().clusters[0]?.state).toEqual(connecting);
});

test("kubeconfig://warnings replaces the warnings", async () => {
  backend({
    catalog_warnings: () => [{ path: "/old", message: "old" }],
  });
  await useCatalog.getState().init();

  const next = [{ path: "/new", message: "new" }];
  await emitEvent("kubeconfig://warnings", next);

  expect(useCatalog.getState().warnings).toEqual(next);
});

test("a failed load sets the error and reload recovers", async () => {
  let fail = true;
  backend({
    catalog_list: () => {
      if (fail) throw { code: "Internal", message: "no store", details: null };
      return [alpha];
    },
  });

  await useCatalog.getState().init();
  expect(useCatalog.getState().error).toBe("no store");
  expect(useCatalog.getState().loading).toBe(false);

  fail = false;
  await useCatalog.getState().reload();
  expect(useCatalog.getState().error).toBeNull();
  expect(useCatalog.getState().clusters).toHaveLength(1);
});
