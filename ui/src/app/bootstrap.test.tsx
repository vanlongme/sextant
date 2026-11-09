import { beforeEach, expect, test, vi } from "vitest";
import { toast } from "../design";
import { resetDockForTest, useDock } from "../stores/dock";
import { resetDockLayoutForTest } from "../stores/dockLayout";
import {
  resetPortForwardsForTest,
  usePortForwards,
} from "../stores/portForwards";
import { resetPrefsForTest } from "../stores/prefs";
import { emitEvent, mockBackend } from "../test/ipc";
import { forward } from "../test/portForwards";
import { bootstrap } from "./bootstrap";

beforeEach(() => {
  resetPortForwardsForTest();
  resetPrefsForTest();
  resetDockLayoutForTest();
  resetDockForTest();
  useDock.setState({ restored: false });
  vi.restoreAllMocks();
  delete document.documentElement.dataset.theme;
});

test("the saved theme is applied on start", async () => {
  mockBackend({ prefs_get: () => ({ theme: "light", syncSources: [] }) });

  await bootstrap();

  expect(document.documentElement.dataset.theme).toBe("light");
});

test("a theme is applied even when prefs cannot be read", async () => {
  mockBackend({
    prefs_get: () => {
      throw { code: "Internal", message: "nope", details: null };
    },
  });

  await bootstrap();

  expect(document.documentElement.dataset.theme).toBeDefined();
});

test("store://warning raises a toast naming the file and the reason", async () => {
  const errors = vi.spyOn(toast, "error");
  mockBackend({ prefs_get: () => ({ theme: "dark", syncSources: [] }) });
  await bootstrap();

  await emitEvent("store://warning", {
    file: "prefs.json",
    message: "moved aside because it was corrupt",
  });

  const shown = errors.mock.calls[0]?.join(" ");
  expect(shown).toContain("prefs.json");
  expect(shown).toContain("moved aside because it was corrupt");
});

test("the saved dock layout is applied on start", async () => {
  mockBackend({
    prefs_get: () => ({ theme: "dark", syncSources: [] }),
    ui_state_get: (a: { key: string }) =>
      a.key === "dock:layout"
        ? {
            version: 1,
            height: 400,
            minimized: true,
            activeId: "create-3",
            tabs: [{ id: "create-3", kind: "create", clusterId: "c1" }],
          }
        : null,
    ui_state_set: () => null,
  });

  await bootstrap();

  expect(useDock.getState()).toMatchObject({
    restored: true,
    height: 400,
    minimized: true,
    activeId: "create-3",
    tabs: [
      { id: "create-3", kind: "create", clusterId: "c1", title: "Create" },
    ],
  });
});

test("the port forwards are read after the preferences, and kept", async () => {
  const backend = mockBackend({
    prefs_get: () => ({ theme: "dark", syncSources: [] }),
    portforward_list: () => [
      forward({ id: "pf-1", state: "running", boundPort: 50123 }),
    ],
  });

  await bootstrap();

  const order = backend.calls
    .map((c) => c.cmd)
    .filter((cmd) => cmd === "prefs_get" || cmd === "portforward_list");
  expect(order).toEqual(["prefs_get", "portforward_list"]);
  expect(usePortForwards.getState().forwards.map((f) => f.id)).toEqual([
    "pf-1",
  ]);
});
