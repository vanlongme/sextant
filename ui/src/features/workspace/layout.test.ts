import { describe, expect, test } from "vitest";
import {
  defaultLayout,
  focusedClusterId,
  initialView,
  layoutSummary,
  MIN_WIDTH,
  parseLayout,
  prune,
  reduce,
  tabActions,
  type WorkspaceAction,
  type WorkspaceLayout,
  type WorkspacePane,
  type WorkspaceTab,
} from "./layout";

function tab(
  id: string,
  clusterId: string,
  over: Partial<WorkspaceTab> = {},
): WorkspaceTab {
  return { id, clusterId, view: "pods", pinned: false, ...over };
}

function pane(
  id: string,
  tabs: WorkspaceTab[],
  active: string | null = tabs[0]?.id ?? null,
): WorkspacePane {
  return { id, tabs, active };
}

const EQUAL: Record<number, number[]> = {
  1: [1],
  2: [0.5, 0.5],
  3: [0.3333, 0.3333, 0.3334],
};

function layout(
  panes: WorkspacePane[],
  over: Partial<WorkspaceLayout> = {},
): WorkspaceLayout {
  return {
    version: 1,
    panes,
    focus: panes[0].id,
    widths: EQUAL[panes.length],
    seq: 10,
    ...over,
  };
}

/** "p1:*t1^,t2 | p2:*t3": `*` marks the active tab, `^` a pinned one. */
function shape(l: WorkspaceLayout): string {
  return l.panes
    .map(
      (p) =>
        `${p.id}:${p.tabs
          .map(
            (t) =>
              `${t.id === p.active ? "*" : ""}${t.id}${t.pinned ? "^" : ""}`,
          )
          .join(",")}`,
    )
    .join(" | ");
}

function sum(widths: number[]): number {
  return widths.reduce((s, w) => s + w, 0);
}

function run(l: WorkspaceLayout, ...actions: WorkspaceAction[]) {
  return actions.reduce(reduce, l);
}

const open = (
  clusterId: string,
  side = false,
  view: "overview" | "pods" = "pods",
): WorkspaceAction => ({ type: "open", clusterId, side, view });

test("the default layout is one empty pane with the whole width", () => {
  expect(defaultLayout()).toEqual({
    version: 1,
    panes: [{ id: "p1", tabs: [], active: null }],
    focus: "p1",
    widths: [1],
    seq: 2,
  });
});

test("a Failed cluster opens on its Overview, any other on its Pods", () => {
  expect([
    initialView({ status: "failed", kind: "unreachable", message: "x" }),
    initialView({ status: "disconnected" }),
    initialView({ status: "connecting" }),
  ]).toEqual(["overview", "pods", "pods"]);
});

describe("open", () => {
  test("opens a tab in the empty focused pane, active, with the given view", () => {
    const next = reduce(defaultLayout(), open("c1", false, "overview"));

    expect(next.panes[0].tabs).toEqual([
      { id: "t2", clusterId: "c1", view: "overview", pinned: false },
    ]);
    expect(next.panes[0].active).toBe("t2");
    expect(next.seq).toBe(3);
  });

  test("a new tab goes after the last one and becomes active", () => {
    const start = layout([
      pane("p1", [tab("t1", "a", { pinned: true }), tab("t2", "b")], "t1"),
    ]);

    const next = reduce(start, open("c"));

    expect(shape(next)).toBe("p1:t1^,t2,*t10");
  });

  test("a cluster already in the focused pane activates its tab there", () => {
    const start = layout([
      pane("p1", [tab("t1", "a"), tab("t2", "b"), tab("t3", "b")], "t1"),
    ]);

    expect(shape(reduce(start, open("b")))).toBe("p1:t1,*t2,t3");
    const onThird = layout([
      pane("p1", [tab("t1", "a"), tab("t2", "b"), tab("t3", "b")], "t3"),
    ]);
    expect(reduce(onThird, open("b"))).toBe(onThird);
  });

  test("only the focused pane is searched", () => {
    const start = layout(
      [pane("p1", [tab("t1", "a")]), pane("p2", [tab("t2", "b")])],
      { focus: "p2" },
    );

    expect(shape(reduce(start, open("a")))).toBe("p1:*t1 | p2:t2,*t10");
  });

  test("side opens a new pane right of the focused one, focused, with equal widths", () => {
    const start = layout(
      [pane("p1", [tab("t1", "a")]), pane("p2", [tab("t2", "b")])],
      { focus: "p1", widths: [0.7, 0.3] },
    );

    const next = reduce(start, open("c", true));

    expect(shape(next)).toBe("p1:*t1 | p11:*t10 | p2:*t2");
    expect(next.focus).toBe("p11");
    expect(next.widths).toEqual([0.3333, 0.3333, 0.3334]);
  });

  test("side opens in the focused pane when it is empty", () => {
    const next = reduce(defaultLayout(), open("a", true));

    expect(shape(next)).toBe("p1:*t2");
  });

  test("with 3 panes, side opens in the focused pane, or activates the cluster's tab there", () => {
    const start = layout(
      [
        pane("p1", [tab("t1", "a")]),
        pane("p2", [tab("t2", "b"), tab("t3", "c")]),
        pane("p3", [tab("t4", "d")]),
      ],
      { focus: "p2" },
    );

    expect(shape(reduce(start, open("e", true)))).toBe(
      "p1:*t1 | p2:t2,t3,*t10 | p3:*t4",
    );
    expect(shape(reduce(start, open("c", true)))).toBe(
      "p1:*t1 | p2:t2,*t3 | p3:*t4",
    );
  });
});

describe("tab actions", () => {
  const two = () =>
    layout(
      [
        pane("p1", [tab("t1", "a", { pinned: true }), tab("t2", "b")], "t2"),
        pane("p2", [tab("t3", "c"), tab("t4", "d")], "t3"),
      ],
      { focus: "p2" },
    );

  test("activate sets the pane's active tab and focuses the pane", () => {
    const next = reduce(two(), { type: "activate", tabId: "t1" });

    expect(shape(next)).toBe("p1:*t1^,t2 | p2:*t3,t4");
    expect(next.focus).toBe("p1");
    const same = reduce(next, { type: "activate", tabId: "t1" });
    expect(same).toBe(next);
  });

  test("close is refused for a pinned tab", () => {
    const start = two();

    expect(reduce(start, { type: "close", tabId: "t1" })).toBe(start);
  });

  test("closing the active tab activates the next one, else the previous one", () => {
    const start = layout([
      pane("p1", [tab("t1", "a"), tab("t2", "b"), tab("t3", "c")], "t2"),
    ]);

    const next = reduce(start, { type: "close", tabId: "t2" });
    expect(shape(next)).toBe("p1:t1,*t3");
    expect(shape(reduce(next, { type: "close", tabId: "t3" }))).toBe("p1:*t1");
  });

  test("closing an inactive tab keeps the active one", () => {
    const start = two();

    expect(shape(reduce(start, { type: "close", tabId: "t4" }))).toBe(
      "p1:t1^,*t2 | p2:*t3",
    );
  });

  test("closeOthers keeps the pinned tabs and this one, which becomes active", () => {
    const start = layout([
      pane(
        "p1",
        [
          tab("t1", "a", { pinned: true }),
          tab("t2", "b"),
          tab("t3", "c"),
          tab("t4", "d"),
        ],
        "t2",
      ),
    ]);

    const next = reduce(start, { type: "closeOthers", tabId: "t3" });

    expect(shape(next)).toBe("p1:t1^,*t3");
    expect(reduce(next, { type: "closeOthers", tabId: "t3" })).toBe(next);
  });

  test("pin puts the tab after the pinned ones, and unpin before the others", () => {
    const start = layout([
      pane(
        "p1",
        [tab("t1", "a", { pinned: true }), tab("t2", "b"), tab("t3", "c")],
        "t2",
      ),
    ]);

    const pinned = reduce(start, { type: "pin", tabId: "t3" });
    expect(shape(pinned)).toBe("p1:t1^,*t3^,t2");
    const unpinned = reduce(pinned, { type: "unpin", tabId: "t1" });
    expect(shape(unpinned)).toBe("p1:t3^,*t1,t2");
    expect(reduce(unpinned, { type: "unpin", tabId: "t1" })).toBe(unpinned);
  });

  test("pin activates the tab and focuses its pane", () => {
    const next = reduce(two(), { type: "pin", tabId: "t2" });

    expect(next.focus).toBe("p1");
    expect(next.panes[0].active).toBe("t2");
  });

  test("setView changes the tab's view and focuses its pane", () => {
    const next = reduce(two(), {
      type: "setView",
      tabId: "t2",
      view: "events",
    });

    expect(next.panes[0].tabs[1].view).toBe("events");
    expect(next.focus).toBe("p1");
    expect(reduce(next, { type: "setView", tabId: "t2", view: "events" })).toBe(
      next,
    );
  });

  test("focus changes the focused pane and ignores an unknown one", () => {
    const start = two();

    expect(reduce(start, { type: "focus", paneId: "p1" }).focus).toBe("p1");
    expect(reduce(start, { type: "focus", paneId: "p9" })).toBe(start);
    expect(reduce(start, { type: "focus", paneId: "p2" })).toBe(start);
  });

  test("reset gives the default layout", () => {
    expect(reduce(two(), { type: "reset" })).toEqual(defaultLayout());
  });

  test("an unknown tab id changes nothing", () => {
    const start = two();
    for (const action of [
      { type: "activate", tabId: "x" },
      { type: "close", tabId: "x" },
      { type: "closeOthers", tabId: "x" },
      { type: "pin", tabId: "x" },
      { type: "setView", tabId: "x", view: "events" },
      { type: "move", tabId: "x", paneId: "p1", index: 0 },
      { type: "moveToNewPane", tabId: "x", paneId: "p1" },
      { type: "split", tabId: "x" },
    ] satisfies WorkspaceAction[]) {
      expect(reduce(start, action)).toBe(start);
    }
  });
});

describe("move", () => {
  test("reorders within a pane, counting the index before the move", () => {
    const start = layout([
      pane("p1", [tab("t1", "a"), tab("t2", "b"), tab("t3", "c")], "t1"),
    ]);

    expect(
      shape(
        reduce(start, { type: "move", tabId: "t1", paneId: "p1", index: 3 }),
      ),
    ).toBe("p1:t2,t3,*t1");
    expect(
      shape(
        reduce(start, { type: "move", tabId: "t3", paneId: "p1", index: 0 }),
      ),
    ).toBe("p1:*t3,t1,t2");
  });

  test("moves to another pane at the index, active and focused there", () => {
    const start = layout([
      pane("p1", [tab("t1", "a"), tab("t2", "b")], "t1"),
      pane("p2", [tab("t3", "c"), tab("t4", "d")], "t3"),
    ]);

    const next = reduce(start, {
      type: "move",
      tabId: "t1",
      paneId: "p2",
      index: 1,
    });

    expect(shape(next)).toBe("p1:*t2 | p2:t3,*t1,t4");
    expect(next.focus).toBe("p2");
  });

  test("a pinned tab stays among the pinned ones, and another stays after them", () => {
    const start = layout([
      pane("p1", [tab("t1", "a", { pinned: true }), tab("t2", "b")], "t1"),
      pane("p2", [tab("t3", "c", { pinned: true }), tab("t4", "d")], "t3"),
    ]);

    expect(
      shape(
        reduce(start, { type: "move", tabId: "t1", paneId: "p2", index: 2 }),
      ),
    ).toBe("p1:*t2 | p2:t3^,*t1^,t4");
    expect(
      shape(
        reduce(start, { type: "move", tabId: "t2", paneId: "p2", index: 0 }),
      ),
    ).toBe("p1:*t1^ | p2:t3^,*t2,t4");
  });

  test("a pane left without tabs is removed and its width goes to its neighbour", () => {
    const start = layout(
      [pane("p1", [tab("t1", "a")]), pane("p2", [tab("t2", "b")])],
      { widths: [0.3, 0.7] },
    );

    const next = reduce(start, {
      type: "move",
      tabId: "t1",
      paneId: "p2",
      index: 1,
    });

    expect(shape(next)).toBe("p2:t2,*t1");
    expect(next.widths).toEqual([1]);
    expect(next.focus).toBe("p2");
  });

  test("moveToNewPane puts the tab in a new pane right of the given one", () => {
    const start = layout([
      pane("p1", [tab("t1", "a"), tab("t2", "b")], "t1"),
      pane("p2", [tab("t3", "c")]),
    ]);

    const beside = reduce(start, {
      type: "moveToNewPane",
      tabId: "t1",
      paneId: "p1",
    });
    expect(shape(beside)).toBe("p1:*t2 | p10:*t1 | p2:*t3");
    expect(beside.focus).toBe("p10");
    expect(beside.widths).toEqual([0.3333, 0.3333, 0.3334]);

    const farRight = reduce(start, {
      type: "moveToNewPane",
      tabId: "t1",
      paneId: "p2",
    });
    expect(shape(farRight)).toBe("p1:*t2 | p2:*t3 | p10:*t1");
  });

  test("moveToNewPane is refused with 3 panes, and for a tab alone in its own pane", () => {
    const full = layout([
      pane("p1", [tab("t1", "a"), tab("t2", "b")]),
      pane("p2", [tab("t3", "c")]),
      pane("p3", [tab("t4", "d")]),
    ]);
    const alone = layout([pane("p1", [tab("t1", "a")])]);

    expect(
      reduce(full, { type: "moveToNewPane", tabId: "t1", paneId: "p1" }),
    ).toBe(full);
    expect(
      reduce(alone, { type: "moveToNewPane", tabId: "t1", paneId: "p1" }),
    ).toBe(alone);
  });
});

describe("split and the 3-pane cap", () => {
  test("split opens a copy of the tab, unpinned, in a new pane right of its pane", () => {
    const start = layout([
      pane("p1", [tab("t1", "a", { view: "events", pinned: true })]),
      pane("p2", [tab("t2", "b")]),
    ]);

    const next = reduce(start, { type: "split", tabId: "t1" });

    expect(shape(next)).toBe("p1:*t1^ | p11:*t10 | p2:*t2");
    expect(next.panes[1].tabs[0]).toEqual({
      id: "t10",
      clusterId: "a",
      view: "events",
      pinned: false,
    });
    expect(next.focus).toBe("p11");
  });

  test("split is refused with 3 panes", () => {
    const start = run(
      defaultLayout(),
      open("a"),
      { type: "split", tabId: "t2" },
      { type: "split", tabId: "t2" },
    );

    expect(start.panes).toHaveLength(3);
    expect(reduce(start, { type: "split", tabId: "t2" })).toBe(start);
  });

  test("no action makes a fourth pane", () => {
    let l = run(defaultLayout(), open("a"), open("b", true), open("c", true));
    for (const action of [
      open("d", true),
      { type: "split", tabId: "t2" },
      { type: "moveToNewPane", tabId: "t2", paneId: "p1" },
    ] satisfies WorkspaceAction[]) {
      l = reduce(l, action);
      expect(l.panes.length).toBeLessThanOrEqual(3);
    }
  });
});

describe("widths", () => {
  const two = (widths: number[]) =>
    layout([pane("p1", [tab("t1", "a")]), pane("p2", [tab("t2", "b")])], {
      widths,
    });

  test("resize moves the splitter between two panes", () => {
    const next = reduce(two([0.5, 0.5]), {
      type: "resize",
      index: 0,
      fraction: 0.62,
    });

    expect(next.widths).toEqual([0.62, 0.38]);
  });

  test("resize keeps both panes at 0.24 or more", () => {
    expect(
      reduce(two([0.5, 0.5]), { type: "resize", index: 0, fraction: 0.1 })
        .widths,
    ).toEqual([0.24, 0.76]);
    expect(
      reduce(two([0.5, 0.5]), { type: "resize", index: 0, fraction: 0.95 })
        .widths,
    ).toEqual([0.76, 0.24]);
  });

  test("resize changes only the two panes beside the splitter", () => {
    const three = layout(
      [
        pane("p1", [tab("t1", "a")]),
        pane("p2", [tab("t2", "b")]),
        pane("p3", [tab("t3", "c")]),
      ],
      { widths: [0.3, 0.4, 0.3] },
    );

    const next = reduce(three, { type: "resize", index: 1, fraction: 0.1 });

    expect(next.widths).toEqual([0.3, 0.24, 0.46]);
    expect(sum(next.widths)).toBeCloseTo(1, 6);
    expect(reduce(three, { type: "resize", index: 2, fraction: 0.5 })).toBe(
      three,
    );
  });

  test("equalize gives every pane the same width", () => {
    const next = reduce(two([0.7, 0.3]), { type: "equalize" });

    expect(next.widths).toEqual([0.5, 0.5]);
    expect(reduce(next, { type: "equalize" })).toBe(next);
  });

  test("closing a middle pane's last tab gives half its width to each neighbour", () => {
    const three = layout(
      [
        pane("p1", [tab("t1", "a")]),
        pane("p2", [tab("t2", "b")]),
        pane("p3", [tab("t3", "c")]),
      ],
      { widths: [0.3, 0.4, 0.3], focus: "p2" },
    );

    const next = reduce(three, { type: "close", tabId: "t2" });

    expect(shape(next)).toBe("p1:*t1 | p3:*t3");
    expect(next.widths).toEqual([0.5, 0.5]);
    expect(next.focus).toBe("p1");
  });

  test("closing the last tab of the only pane leaves it empty", () => {
    const one = layout([pane("p1", [tab("t1", "a")])]);

    const next = reduce(one, { type: "close", tabId: "t1" });

    expect(next.panes).toEqual([{ id: "p1", tabs: [], active: null }]);
    expect(next.widths).toEqual([1]);
  });

  test("every pane stays at 0.24 or more and the widths add up to 1 after any sequence", () => {
    let l = defaultLayout();
    const actions: WorkspaceAction[] = [
      open("a"),
      open("b", true),
      { type: "resize", index: 0, fraction: 0.3 },
      open("c", true),
      { type: "resize", index: 1, fraction: 0.05 },
      { type: "close", tabId: "t4" },
      { type: "split", tabId: "t2" },
      { type: "resize", index: 0, fraction: 0.9 },
      { type: "close", tabId: "t2" },
    ];
    for (const action of actions) {
      l = reduce(l, action);
      expect(l.widths).toHaveLength(l.panes.length);
      for (const w of l.widths) expect(w).toBeGreaterThanOrEqual(MIN_WIDTH);
      expect(sum(l.widths)).toBeCloseTo(1, 6);
    }
  });
});

describe("prune", () => {
  test("drops the tabs of clusters no longer in the catalog, and the panes they empty", () => {
    const start = layout(
      [
        pane("p1", [tab("t1", "a"), tab("t2", "gone")], "t2"),
        pane("p2", [tab("t3", "gone")]),
      ],
      { focus: "p2" },
    );

    const next = prune(start, ["a", "b"]);

    expect(shape(next)).toBe("p1:*t1");
    expect(next.focus).toBe("p1");
    expect(next.widths).toEqual([1]);
  });

  test("returns the same layout when every cluster is known", () => {
    const start = layout([pane("p1", [tab("t1", "a")])]);

    expect(prune(start, ["a"])).toBe(start);
  });

  test("keeps one empty pane when nothing is left", () => {
    const start = layout([
      pane("p1", [tab("t1", "x")]),
      pane("p2", [tab("t2", "y")]),
    ]);

    expect(prune(start, [])).toEqual({
      ...start,
      panes: [{ id: "p1", tabs: [], active: null }],
      widths: [1],
    });
  });
});

describe("parseLayout", () => {
  const good = layout(
    [
      pane("p1", [tab("t1", "a", { pinned: true }), tab("t2", "b")], "t2"),
      pane("p2", [tab("t3", "c", { view: "events" })]),
    ],
    { focus: "p2", widths: [0.6, 0.4] },
  );

  test("a stored layout comes back as it was", () => {
    expect(parseLayout(JSON.parse(JSON.stringify(good)))).toEqual(good);
  });

  test("pinned tabs are put first", () => {
    const stored = layout([
      pane("p1", [tab("t1", "a"), tab("t2", "b", { pinned: true })], "t1"),
    ]);

    expect(shape(parseLayout(stored))).toBe("p1:t2^,*t1");
  });

  test.each<[string, unknown]>([
    ["nothing", null],
    ["a list", []],
    ["another version", { ...good, version: 2 }],
    ["no panes", { ...good, panes: [], widths: [] }],
    [
      "four panes",
      {
        ...good,
        panes: [1, 2, 3, 4].map((n) => pane(`p${n}`, [tab(`t${n}`, "a")])),
        widths: [0.25, 0.25, 0.25, 0.25],
      },
    ],
    ["a width below 0.24", { ...good, widths: [0.8, 0.2] }],
    ["widths that do not add up to 1", { ...good, widths: [0.5, 0.4] }],
    ["one width for two panes", { ...good, widths: [1] }],
    [
      "an unknown view",
      {
        ...good,
        panes: [
          pane("p1", [tab("t1", "a", { view: "logs" as "pods" })]),
          good.panes[1],
        ],
      },
    ],
    [
      "an active tab of another pane",
      { ...good, panes: [pane("p1", [tab("t1", "a")], "t3"), good.panes[1]] },
    ],
    ["a focus that names no pane", { ...good, focus: "p9" }],
    [
      "a repeated id",
      { ...good, panes: [good.panes[0], pane("p2", [tab("t1", "c")])] },
    ],
    [
      "an empty pane beside another",
      { ...good, panes: [good.panes[0], pane("p2", [])] },
    ],
    ["a fractional seq", { ...good, seq: 1.5 }],
    [
      "a tab without its cluster",
      {
        ...good,
        panes: [
          pane("p1", [{ id: "t1", view: "pods", pinned: false }] as never),
          good.panes[1],
        ],
      },
    ],
  ])("%s is replaced by the default", (_name, value) => {
    expect(parseLayout(value)).toEqual(defaultLayout());
  });
});

test("the summary uses singulars for 1", () => {
  const one = layout([pane("p1", [tab("t1", "a", { pinned: true })])]);
  const more = layout([
    pane("p1", [tab("t1", "a"), tab("t2", "b", { pinned: true })]),
    pane("p2", [tab("t3", "a"), tab("t4", "c", { pinned: true })]),
  ]);

  expect(layoutSummary(defaultLayout())).toBe(
    "1 pane · 0 clusters · 0 tabs · 0 pinned",
  );
  expect(layoutSummary(one)).toBe("1 pane · 1 cluster · 1 tab · 1 pinned");
  expect(layoutSummary(more)).toBe("2 panes · 3 clusters · 4 tabs · 2 pinned");
});

test("tabActions says which menu items apply", () => {
  const two = layout([
    pane("p1", [tab("t1", "a", { pinned: true }), tab("t2", "b")]),
    pane("p2", [tab("t3", "c")]),
  ]);
  const three = run(two, { type: "split", tabId: "t3" });

  expect(tabActions(two, "t1")).toEqual({
    side: true,
    left: false,
    right: true,
    newPane: true,
    close: false,
    closeOthers: true,
  });
  expect(tabActions(two, "t3")).toEqual({
    side: true,
    left: true,
    right: false,
    newPane: false,
    close: true,
    closeOthers: false,
  });
  expect(tabActions(three, "t2")).toMatchObject({
    side: false,
    newPane: false,
    closeOthers: false,
  });
  expect(tabActions(two, "x")).toBeNull();
});

test("the focused cluster is the focused pane's active tab's", () => {
  const two = layout(
    [
      pane("p1", [tab("t1", "a")]),
      pane("p2", [tab("t2", "b"), tab("t3", "c")], "t3"),
    ],
    { focus: "p2" },
  );

  expect(focusedClusterId(two)).toBe("c");
  expect(focusedClusterId(defaultLayout())).toBeNull();
});
