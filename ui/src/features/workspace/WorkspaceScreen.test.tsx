import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "../../app/App";
import { resetCatalogForTest } from "../../stores/catalog";
import { resetShellForTest } from "../../stores/shell";
import { resetWorkspaceForTest, useWorkspace } from "../../stores/workspace";
import { mockBackend } from "../../test/ipc";
import { connectClusters } from "../../test/terminal";
import { showWorkspace, wsLayout, wsPane, wsTab } from "../../test/workspace";

const TWO = wsLayout(
  [wsPane("p1", [wsTab("t1", "a")]), wsPane("p2", [wsTab("t2", "b")])],
  { widths: [0.6, 0.4] },
);

function panes(): HTMLElement[] {
  return screen.getAllByTestId("workspace-pane");
}

function splitter(): HTMLElement {
  return screen.getByTestId("workspace-splitter");
}

beforeEach(() => {
  resetCatalogForTest();
  resetShellForTest();
  resetWorkspaceForTest();
  connectClusters({ id: "a", name: "alpha" }, { id: "b", name: "beta" });
});

afterEach(() => {
  vi.restoreAllMocks();
  window.location.hash = "";
});

test("the app routes /workspace to the Workspace page", async () => {
  window.location.hash = "#/workspace";
  mockBackend({
    catalog_list: () => [],
    catalog_warnings: () => [],
    hotbar_get: () => [],
    ui_state_get: () => null,
    ui_state_set: () => null,
  });

  render(<App />);

  expect(await screen.findByTestId("workspace-page")).toBeTruthy();
  expect(await screen.findByTestId("workspace-summary")).toBeTruthy();
});

test("a new Workspace is one empty pane that says how to fill it", async () => {
  await showWorkspace(null);

  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
    "Workspace",
  );
  expect(screen.getByTestId("workspace-summary").textContent).toBe(
    "1 pane · 0 clusters · 0 tabs · 0 pinned",
  );
  expect(panes()).toHaveLength(1);
  expect(panes()[0].getAttribute("data-pane")).toBe("0");
  expect(panes()[0].getAttribute("aria-label")).toBe("Pane 1 of 1");
  expect(screen.getByTestId("workspace-empty").textContent).toBe(
    "Pick a cluster in the hotbar to open it hereShift-click opens it in a new pane to the side.",
  );
  expect(screen.queryByTestId("workspace-splitter")).toBeNull();
});

test("the saved panes take their widths, with a splitter between them", async () => {
  await showWorkspace(TWO);

  expect(panes().map((p) => p.style.flexGrow)).toEqual(["0.6", "0.4"]);
  expect(panes().map((p) => p.getAttribute("aria-label"))).toEqual([
    "Pane 1 of 2: alpha · Pods",
    "Pane 2 of 2: beta · Pods",
  ]);
  expect(screen.getByTestId("workspace-summary").textContent).toBe(
    "2 panes · 2 clusters · 2 tabs · 0 pinned",
  );
  const handle = splitter();
  expect({
    role: handle.getAttribute("role"),
    orientation: handle.getAttribute("aria-orientation"),
    min: handle.getAttribute("aria-valuemin"),
    max: handle.getAttribute("aria-valuemax"),
    now: handle.getAttribute("aria-valuenow"),
    label: handle.getAttribute("aria-label"),
  }).toEqual({
    role: "separator",
    orientation: "vertical",
    min: "24",
    max: "76",
    now: "60",
    label: "Resize panes 1 and 2",
  });
});

test("Left and Right move the splitter by 2%, and never past 24% or 76%", async () => {
  await showWorkspace(TWO);

  fireEvent.keyDown(splitter(), { key: "ArrowRight" });
  expect(splitter().getAttribute("aria-valuenow")).toBe("62");
  fireEvent.keyDown(splitter(), { key: "ArrowLeft" });
  fireEvent.keyDown(splitter(), { key: "ArrowLeft" });
  expect(splitter().getAttribute("aria-valuenow")).toBe("58");
  for (let i = 0; i < 30; i++) {
    fireEvent.keyDown(splitter(), { key: "ArrowRight" });
  }
  expect(splitter().getAttribute("aria-valuenow")).toBe("76");
  expect(useWorkspace.getState().layout.widths).toEqual([0.76, 0.24]);
});

test("a double-click makes the panes equal", async () => {
  await showWorkspace(TWO);

  fireEvent.doubleClick(splitter());

  expect(splitter().getAttribute("aria-valuenow")).toBe("50");
  expect(panes().map((p) => p.style.flexGrow)).toEqual(["0.5", "0.5"]);
});

test("dragging the splitter follows the pointer until it is let go", async () => {
  await showWorkspace(TWO);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 1000, 600),
  );

  fireEvent.pointerDown(splitter(), { button: 0, clientX: 600, pointerId: 1 });
  fireEvent.pointerMove(splitter(), { clientX: 700, pointerId: 1 });
  expect(splitter().getAttribute("aria-valuenow")).toBe("70");
  fireEvent.pointerUp(splitter(), { pointerId: 1 });
  fireEvent.pointerMove(splitter(), { clientX: 400, pointerId: 1 });

  expect(splitter().getAttribute("aria-valuenow")).toBe("70");
});

test("the splitter explains itself in a tooltip", async () => {
  await showWorkspace(TWO);

  fireEvent.focus(splitter());

  expect((await screen.findByRole("tooltip")).textContent).toBe(
    "Drag to resize, double-click to make the panes equal",
  );
});

test("Reset layout restores one empty pane", async () => {
  await showWorkspace(TWO);

  fireEvent.click(screen.getByTestId("workspace-reset"));

  expect(panes()).toHaveLength(1);
  expect(screen.getByTestId("workspace-empty")).toBeTruthy();
  expect(screen.getByTestId("workspace-summary").textContent).toBe(
    "1 pane · 0 clusters · 0 tabs · 0 pinned",
  );
});

test("Ctrl+\\ opens the focused pane's active tab to the side, but not from a field", async () => {
  await showWorkspace(
    wsLayout([wsPane("p1", [wsTab("t1", "a", { view: "events" })])]),
  );
  const page = screen.getByTestId("workspace-page");
  const field = document.createElement("input");
  page.append(field);

  fireEvent.keyDown(field, { key: "\\", ctrlKey: true });
  expect(panes()).toHaveLength(1);

  fireEvent.keyDown(page, { key: "\\", ctrlKey: true });
  expect(panes()).toHaveLength(2);
  expect(useWorkspace.getState().layout.panes[1].tabs).toEqual([
    { id: "t10", clusterId: "a", view: "events", pinned: false },
  ]);
  expect(panes()[1].getAttribute("data-focused")).toBe("true");
});

test("a pointer press or the focus inside a pane makes it the focused pane", async () => {
  await showWorkspace(TWO);
  const [first, second] = panes();
  expect(first.getAttribute("data-focused")).toBe("true");

  fireEvent.pointerDown(second);
  expect(useWorkspace.getState().layout.focus).toBe("p2");
  expect(second.getAttribute("data-focused")).toBe("true");

  const inside = document.createElement("button");
  first.append(inside);
  fireEvent.focusIn(inside);
  expect(useWorkspace.getState().layout.focus).toBe("p1");
});
