import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resetCatalogForTest } from "../../stores/catalog";
import { resetShellForTest } from "../../stores/shell";
import { resetWorkspaceForTest, useWorkspace } from "../../stores/workspace";
import { connectClusters } from "../../test/terminal";
import { showWorkspace, wsLayout, wsPane, wsTab } from "../../test/workspace";

/** One pane: alpha · Pods (active), beta · Events, and alpha · Overview pinned first. */
const ONE = wsLayout([
  wsPane(
    "p1",
    [
      wsTab("t3", "a", { view: "overview", pinned: true }),
      wsTab("t1", "a"),
      wsTab("t2", "b", { view: "events" }),
    ],
    "t1",
  ),
]);

const TWO = wsLayout([
  wsPane("p1", [wsTab("t1", "a"), wsTab("t2", "b", { view: "events" })]),
  wsPane("p2", [wsTab("t3", "b")]),
]);

function tabs(pane = 0): HTMLElement[] {
  return within(screen.getAllByTestId("workspace-pane")[pane]).getAllByTestId(
    "workspace-tab",
  );
}

function tab(label: string): HTMLElement {
  return screen.getByRole("tab", { name: label });
}

/** "p1:*t1,t2 | p2:*t3": each pane's tabs, `*` before the active one, `^` after a pinned one. */
function shape(): string {
  return useWorkspace
    .getState()
    .layout.panes.map(
      (p) =>
        `${p.id}:${p.tabs
          .map(
            (t) =>
              `${p.active === t.id ? "*" : ""}${t.id}${t.pinned ? "^" : ""}`,
          )
          .join(",")}`,
    )
    .join(" | ");
}

function menuItem(id: string): HTMLElement {
  return screen.getByTestId(`workspace-menu-${id}`);
}

beforeEach(() => {
  resetCatalogForTest();
  resetShellForTest();
  resetWorkspaceForTest();
  connectClusters({ id: "a", name: "alpha" }, { id: "b", name: "beta" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

test("each tab shows its cluster, view, pin state and selection", async () => {
  await showWorkspace(ONE);

  expect(screen.getByTestId("workspace-strip").getAttribute("aria-label")).toBe(
    "Tabs in pane 1",
  );
  expect(
    tabs().map((t) => ({
      name: t.getAttribute("aria-label"),
      cluster: t.getAttribute("data-cluster"),
      view: t.getAttribute("data-view"),
      pinned: t.getAttribute("data-pinned"),
      selected: t.getAttribute("aria-selected"),
      tabIndex: t.tabIndex,
      text: t.textContent,
    })),
  ).toEqual([
    {
      name: "alpha · Overview, pinned",
      cluster: "a",
      view: "overview",
      pinned: "true",
      selected: "false",
      tabIndex: -1,
      text: "AL",
    },
    {
      name: "alpha · Pods",
      cluster: "a",
      view: "pods",
      pinned: "false",
      selected: "true",
      tabIndex: 0,
      text: "ALalpha · Pods",
    },
    {
      name: "beta · Events",
      cluster: "b",
      view: "events",
      pinned: "false",
      selected: "false",
      tabIndex: -1,
      text: "BEbeta · Events",
    },
  ]);
  expect(within(tabs()[1]).getByRole("img").getAttribute("aria-label")).toBe(
    "Connected",
  );
});

test("a pinned tab shows its label in a tooltip", async () => {
  await showWorkspace(ONE);

  fireEvent.focus(tabs()[0]);

  expect((await screen.findByRole("tooltip")).textContent).toBe(
    "alpha · Overview",
  );
});

test("a click activates a tab", async () => {
  await showWorkspace(ONE);

  fireEvent.click(tab("beta · Events"));

  expect(shape()).toBe("p1:t3^,t1,*t2");
  expect(tab("beta · Events").getAttribute("aria-selected")).toBe("true");
});

test("Pin tab and Close tab act on their tab; Close is disabled on a pinned tab", async () => {
  await showWorkspace(ONE);
  const pins = screen.getAllByTestId("workspace-tab-pin");
  const closes = screen.getAllByTestId("workspace-tab-close");
  expect(pins.map((b) => b.getAttribute("aria-label"))).toEqual([
    "Unpin tab",
    "Pin tab",
    "Pin tab",
  ]);
  expect(closes.map((b) => (b as HTMLButtonElement).disabled)).toEqual([
    true,
    false,
    false,
  ]);

  fireEvent.click(closes[2]);
  expect(shape()).toBe("p1:t3^,*t1");

  fireEvent.click(screen.getAllByTestId("workspace-tab-pin")[1]);
  expect(shape()).toBe("p1:t3^,*t1^");
});

test("the disabled Close says to unpin first", async () => {
  await showWorkspace(ONE);

  const close = screen.getAllByTestId("workspace-tab-close")[0];
  fireEvent.focus(close.parentElement as HTMLElement);

  expect((await screen.findByRole("tooltip")).textContent).toBe("Unpin first");
});

test("a middle-click closes an unpinned tab, never a pinned one", async () => {
  await showWorkspace(ONE);

  fireEvent(
    tabs()[0],
    new MouseEvent("auxclick", { bubbles: true, button: 1 }),
  );
  expect(shape()).toBe("p1:t3^,*t1,t2");

  fireEvent(
    tabs()[2],
    new MouseEvent("auxclick", { bubbles: true, button: 1 }),
  );
  expect(shape()).toBe("p1:t3^,*t1");
});

test("the split button opens the active tab beside the pane", async () => {
  await showWorkspace(ONE);
  const split = screen.getByTestId("workspace-split");
  expect(split.getAttribute("aria-label")).toBe(
    "Split right: open alpha beside this pane",
  );

  fireEvent.click(split);

  expect(shape()).toBe("p1:t3^,*t1,t2 | p11:*t10");
  expect(useWorkspace.getState().layout.focus).toBe("p11");
});

test("with 3 panes the split button is disabled and says why", async () => {
  await showWorkspace(
    wsLayout([
      wsPane("p1", [wsTab("t1", "a")]),
      wsPane("p2", [wsTab("t2", "b")]),
      wsPane("p3", [wsTab("t3", "a")]),
    ]),
  );
  const splits = screen.getAllByTestId("workspace-split");
  expect(splits.map((b) => (b as HTMLButtonElement).disabled)).toEqual([
    true,
    true,
    true,
  ]);

  fireEvent.focus(splits[0].parentElement as HTMLElement);

  expect((await screen.findByRole("tooltip")).textContent).toBe(
    "3 panes at most",
  );
});

test("the context menu lists every item, with hints, disabling what does not apply", async () => {
  await showWorkspace(ONE);

  fireEvent.contextMenu(tab("alpha · Pods"));

  const menu = await screen.findByRole("menu");
  expect(menu.getAttribute("aria-label")).toBe("Actions for alpha · Pods");
  expect(
    within(menu)
      .getAllByRole("menuitem")
      .map((item) => [
        item.getAttribute("data-testid"),
        item.textContent,
        item.hasAttribute("data-disabled"),
      ]),
  ).toEqual([
    ["workspace-menu-pin", "Pin tab", false],
    ["workspace-menu-side", "Open to the sideCtrl+\\", false],
    ["workspace-menu-left", "Move to the left pane", true],
    ["workspace-menu-right", "Move to the right pane", true],
    ["workspace-menu-new", "Move to a new pane", false],
    ["workspace-menu-close", "Close tabDelete", false],
    ["workspace-menu-others", "Close other tabsKeeps pinned tabs", false],
  ]);
});

test("on a pinned tab in a full Workspace, the menu says why Open to the side and Close are off", async () => {
  await showWorkspace(
    wsLayout([
      wsPane("p1", [wsTab("t1", "a", { pinned: true })]),
      wsPane("p2", [wsTab("t2", "b")]),
      wsPane("p3", [wsTab("t3", "a")]),
    ]),
  );

  fireEvent.contextMenu(tab("alpha · Pods, pinned"));
  await screen.findByRole("menu");

  expect(
    ["pin", "side", "left", "right", "new", "close", "others"].map((id) => [
      menuItem(id).textContent,
      menuItem(id).hasAttribute("data-disabled"),
    ]),
  ).toEqual([
    ["Unpin tab", false],
    ["Open to the side3 panes at most", true],
    ["Move to the left pane", true],
    ["Move to the right pane", false],
    ["Move to a new pane", true],
    ["Close tabUnpin first", true],
    ["Close other tabsKeeps pinned tabs", true],
  ]);
});

test("Move to the right pane puts the tab last in that pane", async () => {
  await showWorkspace(TWO);

  fireEvent.contextMenu(tab("alpha · Pods"));
  fireEvent.click(await screen.findByTestId("workspace-menu-right"));

  expect(shape()).toBe("p1:*t2 | p2:t3,*t1");
  expect(useWorkspace.getState().layout.focus).toBe("p2");
});

test("Move to the left pane, and the last tab's pane closes", async () => {
  await showWorkspace(TWO);

  fireEvent.contextMenu(tab("beta · Pods"));
  fireEvent.click(await screen.findByTestId("workspace-menu-left"));

  expect(shape()).toBe("p1:t1,t2,*t3");
  expect(useWorkspace.getState().layout.widths).toEqual([1]);
});

test("Move to a new pane takes the tab out beside its pane", async () => {
  await showWorkspace(TWO);

  fireEvent.contextMenu(tab("beta · Events"));
  fireEvent.click(await screen.findByTestId("workspace-menu-new"));

  expect(shape()).toBe("p1:*t1 | p10:*t2 | p2:*t3");
  fireEvent.contextMenu(tab("alpha · Pods"));
  expect(menuItem("side").hasAttribute("data-disabled")).toBe(true);
  expect(menuItem("new").hasAttribute("data-disabled")).toBe(true);
});

test("Close other tabs keeps the pinned ones; Open to the side copies the tab", async () => {
  await showWorkspace(ONE);

  fireEvent.contextMenu(tab("alpha · Pods"));
  fireEvent.click(await screen.findByTestId("workspace-menu-others"));
  expect(shape()).toBe("p1:t3^,*t1");

  fireEvent.contextMenu(tab("alpha · Pods"));
  fireEvent.click(await screen.findByTestId("workspace-menu-side"));
  expect(shape()).toBe("p1:t3^,*t1 | p11:*t10");
});

test("Left, Right, Home and End move the focus along the strip", async () => {
  await showWorkspace(ONE);
  const [pinned, pods, events] = tabs();
  pods.focus();

  fireEvent.keyDown(pods, { key: "ArrowRight" });
  expect(document.activeElement).toBe(events);
  fireEvent.keyDown(events, { key: "ArrowRight" });
  expect(document.activeElement).toBe(pinned);
  fireEvent.keyDown(pinned, { key: "ArrowLeft" });
  expect(document.activeElement).toBe(events);
  fireEvent.keyDown(events, { key: "Home" });
  expect(document.activeElement).toBe(pinned);
  fireEvent.keyDown(pinned, { key: "End" });
  expect(document.activeElement).toBe(events);
  expect(shape()).toBe("p1:t3^,*t1,t2");
});

test("Delete closes the focused tab and focuses the next active one, but not a pinned tab", async () => {
  await showWorkspace(ONE);

  fireEvent.keyDown(tabs()[0], { key: "Delete" });
  expect(shape()).toBe("p1:t3^,*t1,t2");

  fireEvent.keyDown(tab("alpha · Pods"), { key: "Delete" });

  expect(shape()).toBe("p1:t3^,*t2");
  expect(document.activeElement).toBe(tab("beta · Events"));
});

test("Shift+F10 and the context-menu key open the menu", async () => {
  await showWorkspace(ONE);

  fireEvent.keyDown(tab("beta · Events"), { key: "F10", shiftKey: true });
  expect((await screen.findByRole("menu")).getAttribute("aria-label")).toBe(
    "Actions for beta · Events",
  );
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

  fireEvent.keyDown(tab("alpha · Pods"), { key: "ContextMenu" });
  expect((await screen.findByRole("menu")).getAttribute("aria-label")).toBe(
    "Actions for alpha · Pods",
  );
});
