import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resetCatalogForTest } from "../../stores/catalog";
import { resetShellForTest } from "../../stores/shell";
import { resetWorkspaceForTest, useWorkspace } from "../../stores/workspace";
import { connectClusters } from "../../test/terminal";
import { showWorkspace, wsLayout, wsPane, wsTab } from "../../test/workspace";

const TWO = wsLayout([
  wsPane("p1", [wsTab("t1", "a"), wsTab("t2", "b", { view: "events" })]),
  wsPane("p2", [wsTab("t3", "b")]),
]);

/** jsdom has no layout: put each drop zone where the pointer can find it. */
function placeZones(): void {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const zones = [
        ...document.querySelectorAll("[data-testid^=workspace-drop-]"),
      ];
      const at = zones.indexOf(this);
      return at >= 0
        ? new DOMRect(at * 200, 100, 180, 300)
        : new DOMRect(0, 0, 0, 0);
    },
  );
}

async function pick(label: string): Promise<void> {
  const tab = screen.getByRole("tab", { name: label });
  fireEvent.pointerDown(tab, {
    isPrimary: true,
    button: 0,
    clientX: 5,
    clientY: 5,
  });
  await act(async () => {
    fireEvent.pointerMove(document, { clientX: 30, clientY: 5 });
  });
}

async function moveTo(x: number, y: number): Promise<void> {
  await act(async () => {
    fireEvent.pointerMove(document, { clientX: x, clientY: y });
  });
}

function zoneLabels(id: "here" | "side"): string[] {
  return screen
    .queryAllByTestId(`workspace-drop-${id}`)
    .map((z) => z.textContent ?? "");
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

test("dragging a tab shows both drop zones in every pane and its label; Esc cancels", async () => {
  await showWorkspace(TWO);
  expect(zoneLabels("here")).toEqual([]);

  await pick("beta · Events");

  expect(zoneLabels("here")).toEqual([
    "Move to this pane",
    "Move to this pane",
  ]);
  expect(zoneLabels("side")).toEqual(["Open to the side", "Open to the side"]);
  expect(screen.getByTestId("workspace-drag-ghost").textContent).toBe(
    "beta · Events",
  );

  await act(async () => {
    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
  });

  expect(zoneLabels("here")).toEqual([]);
  expect(useWorkspace.getState().layout).toEqual(TWO);
});

test("with 3 panes there is no Open to the side zone", async () => {
  await showWorkspace(
    wsLayout([
      wsPane("p1", [wsTab("t1", "a")]),
      wsPane("p2", [wsTab("t2", "b")]),
      wsPane("p3", [wsTab("t3", "a", { view: "events" })]),
    ]),
  );

  await pick("alpha · Pods");

  expect(zoneLabels("here")).toHaveLength(3);
  expect(zoneLabels("side")).toEqual([]);
});

test("dropping on Open to the side moves the tab to a new pane beside that one", async () => {
  placeZones();
  await showWorkspace(TWO);
  await pick("beta · Events");
  // Zones, in order: here p1, side p1, here p2, side p2.
  await moveTo(450, 200);
  expect(
    screen.getAllByTestId("workspace-drop-here")[1].getAttribute("data-over"),
  ).toBe("true");

  await moveTo(650, 200);
  await act(async () => {
    fireEvent.pointerUp(document, { clientX: 650, clientY: 200 });
  });

  expect(
    useWorkspace.getState().layout.panes.map((p) => p.tabs.map((t) => t.id)),
  ).toEqual([["t1"], ["t3"], ["t2"]]);
  expect(zoneLabels("here")).toEqual([]);
});

test("dropping on Move to this pane puts the tab last in that pane", async () => {
  placeZones();
  await showWorkspace(TWO);
  await pick("alpha · Pods");

  await moveTo(450, 200);
  await act(async () => {
    fireEvent.pointerUp(document, { clientX: 450, clientY: 200 });
  });

  expect(
    useWorkspace.getState().layout.panes.map((p) => p.tabs.map((t) => t.id)),
  ).toEqual([["t2"], ["t3", "t1"]]);
});
