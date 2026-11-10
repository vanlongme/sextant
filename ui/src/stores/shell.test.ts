import { beforeEach, expect, test } from "vitest";
import { resetShellForTest, useShell } from "./shell";

beforeEach(() => resetShellForTest());

test("opening a shell dialog replaces the one that is open", () => {
  useShell.getState().open("palette");
  useShell.getState().open("about");
  expect(useShell.getState().dialog).toBe("about");
});

test("opening the open dialog again changes nothing", () => {
  useShell.getState().open("palette");
  let changes = 0;
  const stop = useShell.subscribe(() => {
    changes += 1;
  });
  useShell.getState().open("palette");
  stop();
  expect(changes).toBe(0);
  expect(useShell.getState().dialog).toBe("palette");
});

test("close closes the named dialog only, or whichever is open", () => {
  useShell.getState().open("shortcuts");
  useShell.getState().close("palette");
  expect(useShell.getState().dialog).toBe("shortcuts");
  useShell.getState().close("shortcuts");
  expect(useShell.getState().dialog).toBeNull();
  useShell.getState().open("about");
  useShell.getState().close();
  expect(useShell.getState().dialog).toBeNull();
});

test("the add-cluster dialog has its own flag", () => {
  useShell.getState().open("palette");
  useShell.getState().openAddCluster();
  expect(useShell.getState()).toMatchObject({
    dialog: "palette",
    addClusterOpen: true,
  });
  useShell.getState().closeAddCluster();
  expect(useShell.getState().addClusterOpen).toBe(false);
});
