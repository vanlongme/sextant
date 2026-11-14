import { expect, test } from "vitest";
import type { DrawerTarget } from "../../kinds/detail/links";
import {
  goBack,
  MAX_ENTRIES,
  OVERVIEW,
  previousEntry,
  pushTarget,
  setTab,
  shownEntry,
  startHistory,
} from "./drawerHistory";

const pod: DrawerTarget = {
  group: "",
  plural: "pods",
  namespace: "n",
  name: "web",
};
const node: DrawerTarget = {
  group: "",
  plural: "nodes",
  namespace: null,
  name: "n1",
};
const config = (name: string): DrawerTarget => ({
  group: "",
  plural: "configmaps",
  namespace: "n",
  name,
});

test("starts at the root, pushes on the Overview tab and goes back", () => {
  const start = startHistory(pod);
  expect(start.entries).toEqual([{ target: pod, tab: OVERVIEW }]);
  expect(startHistory(null).entries).toEqual([]);
  const pushed = pushTarget(start, node);
  expect(shownEntry(pushed)).toEqual({ target: node, tab: OVERVIEW });
  expect(previousEntry(pushed)?.target).toEqual(pod);
  const back = goBack(pushed);
  expect(shownEntry(back)?.target).toEqual(pod);
  expect(previousEntry(back)).toBeNull();
});

test("pushing the shown target and going back at the root change nothing", () => {
  const start = startHistory(pod);
  expect(pushTarget(start, { ...pod })).toBe(start);
  expect(goBack(start)).toBe(start);
  expect(pushTarget(startHistory(null), pod).entries).toEqual([]);
});

test("the 20-entry cap drops the entry after the root", () => {
  let h = startHistory(pod);
  for (let i = 1; i <= MAX_ENTRIES; i += 1) h = pushTarget(h, config(`c${i}`));
  expect(h.entries).toHaveLength(MAX_ENTRIES);
  expect(h.entries[0].target).toEqual(pod);
  expect(h.entries[1].target.name).toBe("c2");
  expect(shownEntry(h)?.target.name).toBe(`c${MAX_ENTRIES}`);
});

test("the tab is kept per entry and restored on back", () => {
  let h = setTab(startHistory(pod), "events");
  h = pushTarget(h, node);
  expect(shownEntry(h)?.tab).toBe(OVERVIEW);
  h = setTab(h, "metrics");
  h = goBack(h);
  expect(shownEntry(h)).toEqual({ target: pod, tab: "events" });
});
