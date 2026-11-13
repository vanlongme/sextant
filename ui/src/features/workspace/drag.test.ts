import { expect, test } from "vitest";
import { wsLayout, wsPane, wsTab } from "../../test/workspace";
import { type DropTarget, dropAction, parseTarget, targetId } from "./drag";
import { reduce, type WorkspaceLayout } from "./layout";

/** "p1:*t1,t2 | p2:*t3": each pane's tabs, `*` before the active one. */
function shape(l: WorkspaceLayout): string {
  return l.panes
    .map(
      (p) =>
        `${p.id}:${p.tabs.map((t) => `${p.active === t.id ? "*" : ""}${t.id}`).join(",")}`,
    )
    .join(" | ");
}

const TWO = wsLayout([
  wsPane("p1", [wsTab("t1", "a"), wsTab("t2", "a"), wsTab("t3", "b")]),
  wsPane("p2", [wsTab("t4", "b")]),
]);

function drop(layout: WorkspaceLayout, tabId: string, target: DropTarget) {
  const action = dropAction(layout, tabId, target);
  return action ? shape(reduce(layout, action)) : null;
}

test("target ids go both ways", () => {
  const targets: DropTarget[] = [
    { kind: "tab", tabId: "t1" },
    { kind: "strip", paneId: "p1" },
    { kind: "here", paneId: "p2" },
    { kind: "side", paneId: "p3" },
  ];
  expect(targets.map(targetId)).toEqual([
    "tab:t1",
    "strip:p1",
    "here:p2",
    "side:p3",
  ]);
  expect(targets.map((t) => parseTarget(targetId(t)))).toEqual(targets);
  expect(["", "tab:", ":p1", "pane:p1", "t1"].map(parseTarget)).toEqual([
    null,
    null,
    null,
    null,
    null,
  ]);
});

test("on a tab of its own strip, the tab takes that tab's place", () => {
  expect(drop(TWO, "t1", { kind: "tab", tabId: "t3" })).toBe(
    "p1:t2,t3,*t1 | p2:*t4",
  );
  expect(drop(TWO, "t3", { kind: "tab", tabId: "t1" })).toBe(
    "p1:*t3,t1,t2 | p2:*t4",
  );
  expect(drop(TWO, "t1", { kind: "tab", tabId: "t2" })).toBe(
    "p1:t2,*t1,t3 | p2:*t4",
  );
});

test("on a tab of another strip, the tab goes before it", () => {
  expect(drop(TWO, "t2", { kind: "tab", tabId: "t4" })).toBe(
    "p1:*t1,t3 | p2:*t2,t4",
  );
});

test("on a strip or on Move to this pane, the tab goes last", () => {
  expect(drop(TWO, "t1", { kind: "strip", paneId: "p2" })).toBe(
    "p1:*t2,t3 | p2:t4,*t1",
  );
  expect(drop(TWO, "t1", { kind: "here", paneId: "p1" })).toBe(
    "p1:t2,t3,*t1 | p2:*t4",
  );
});

test("on Open to the side, the tab moves to a new pane beside that one", () => {
  expect(drop(TWO, "t3", { kind: "side", paneId: "p2" })).toBe(
    "p1:*t1,t2 | p2:*t4 | p10:*t3",
  );
});

test("nothing happens on itself, on unknown ids, or to the side of 3 panes", () => {
  const full = wsLayout([
    wsPane("p1", [wsTab("t1", "a"), wsTab("t2", "a")]),
    wsPane("p2", [wsTab("t3", "b")]),
    wsPane("p3", [wsTab("t4", "b")]),
  ]);
  expect([
    dropAction(TWO, "t1", { kind: "tab", tabId: "t1" }),
    dropAction(TWO, "t9", { kind: "strip", paneId: "p1" }),
    dropAction(TWO, "t1", { kind: "tab", tabId: "t9" }),
    dropAction(TWO, "t1", { kind: "here", paneId: "p9" }),
    dropAction(full, "t1", { kind: "side", paneId: "p1" }),
  ]).toEqual([null, null, null, null, null]);
});
