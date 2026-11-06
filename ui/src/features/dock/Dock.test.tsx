import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import {
  editTab,
  newCreateTab,
  resetDockForTest,
  useDock,
} from "../../stores/dock";
import { flush, mockBackend } from "../../test/ipc";
import { Dock } from "./Dock";

vi.mock("../editor/YamlEditor", () => ({
  YamlEditor: (props: {
    value: string;
    onChange(v: string): void;
    readOnly?: boolean;
    testId?: string;
  }) => (
    <textarea
      data-testid={props.testId}
      value={props.value}
      readOnly={props.readOnly}
      onChange={(e) => props.onChange(e.target.value)}
    />
  ),
}));

const PODS: ResourceRef = {
  group: "",
  version: "v1",
  plural: "pods",
  kind: "Pod",
  namespaced: true,
};

const WEB = editTab("c1", PODS, "team-a", "web");
const API = editTab("c1", PODS, "team-a", "api");
const OTHER = editTab("c2", PODS, "team-a", "other");

function panel(id: string) {
  return screen.getByTestId<HTMLElement>(`dock-panel-${id}`);
}

function editorOf(id: string) {
  return within(panel(id)).getByTestId<HTMLTextAreaElement>("yaml-editor");
}

async function show(clusterId = "c1") {
  const view = render(<Dock clusterId={clusterId} />);
  await act(flush);
  return view;
}

beforeEach(() => {
  vi.stubGlobal("innerHeight", 1000);
  mockBackend({
    resource_get_yaml: (a: { name: string }) => `kind: Pod\nname: ${a.name}\n`,
  });
});

afterEach(() => {
  resetDockForTest();
  vi.unstubAllGlobals();
});

test("with no tabs the dock offers Create and no content", async () => {
  await show();

  expect(screen.getByTestId("dock")).toBeTruthy();
  expect(screen.queryByTestId("dock-minimize")).toBeNull();
  expect(screen.queryByTestId("dock-resize")).toBeNull();
  expect(screen.queryByTestId("yaml-editor")).toBeNull();
});

test("Create opens a create tab for this cluster", async () => {
  await show();

  fireEvent.click(screen.getByTestId("create-resource"));
  await act(flush);

  const { tabs, activeId } = useDock.getState();
  expect(tabs).toHaveLength(1);
  expect(tabs[0]).toMatchObject({ kind: "create", clusterId: "c1" });
  expect(activeId).toBe(tabs[0].id);
  expect(screen.getByTestId(`dock-tab-${tabs[0].id}`)).toBeTruthy();
  expect(screen.getByTestId("create-apply")).toBeTruthy();
});

test("an edit tab shows its object and is named after it", async () => {
  useDock.getState().open(WEB);
  await show();

  expect(screen.getByTestId(`dock-tab-${WEB.id}`).textContent).toContain(
    "Pod team-a/web",
  );
  expect(editorOf(WEB.id).value).toContain("name: web");
});

test("clicking a tab switches to it and keeps the other's edits", async () => {
  useDock.getState().open(WEB);
  useDock.getState().open(API);
  await show();

  expect(panel(API.id).hidden).toBe(false);
  expect(panel(WEB.id).hidden).toBe(true);
  fireEvent.change(editorOf(API.id), { target: { value: "edited: true\n" } });

  fireEvent.click(screen.getByTestId(`dock-tab-${WEB.id}`));
  expect(panel(WEB.id).hidden).toBe(false);
  expect(panel(API.id).hidden).toBe(true);

  fireEvent.click(screen.getByTestId(`dock-tab-${API.id}`));
  expect(editorOf(API.id).value).toBe("edited: true\n");
});

test("closing a clean tab does not ask", async () => {
  useDock.getState().open(WEB);
  await show();

  fireEvent.click(screen.getByTestId(`dock-close-${WEB.id}`));
  await act(flush);

  expect(screen.queryByRole("dialog")).toBeNull();
  expect(useDock.getState().tabs).toEqual([]);
});

test("closing a dirty tab asks first", async () => {
  useDock.getState().open(WEB);
  await show();
  fireEvent.change(editorOf(WEB.id), { target: { value: "edited: true\n" } });

  fireEvent.click(screen.getByTestId(`dock-close-${WEB.id}`));
  const dialog = await screen.findByRole("dialog");
  expect(dialog.textContent).toContain("Pod team-a/web");

  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await act(flush);
  expect(useDock.getState().tabs).toHaveLength(1);
  expect(editorOf(WEB.id).value).toBe("edited: true\n");

  fireEvent.click(screen.getByTestId(`dock-close-${WEB.id}`));
  const again = await screen.findByRole("dialog");
  fireEvent.click(within(again).getByRole("button", { name: "Discard" }));
  await act(flush);
  expect(useDock.getState().tabs).toEqual([]);
});

test("a dirty tab is marked in the tab strip", async () => {
  useDock.getState().open(WEB);
  await show();
  const tab = screen.getByTestId(`dock-tab-${WEB.id}`);
  expect(tab.dataset.dirty).toBe("false");

  fireEvent.change(editorOf(WEB.id), { target: { value: "edited: true\n" } });

  expect(screen.getByTestId(`dock-tab-${WEB.id}`).dataset.dirty).toBe("true");
});

test("minimized hides content and keeps tabs", async () => {
  useDock.getState().open(WEB);
  await show();
  fireEvent.change(editorOf(WEB.id), { target: { value: "edited: true\n" } });

  fireEvent.click(screen.getByTestId("dock-minimize"));

  expect(useDock.getState().minimized).toBe(true);
  expect(panel(WEB.id).hidden).toBe(true);
  expect(screen.getByTestId(`dock-tab-${WEB.id}`)).toBeTruthy();
  expect(screen.queryByTestId("dock-resize")).toBeNull();
  expect(screen.getByTestId("dock").style.height).toBe("");

  fireEvent.click(screen.getByTestId("dock-minimize"));

  expect(panel(WEB.id).hidden).toBe(false);
  expect(editorOf(WEB.id).value).toBe("edited: true\n");
});

test("clicking a tab while minimized shows the dock again", async () => {
  useDock.getState().open(WEB);
  useDock.getState().setMinimized(true);
  await show();

  fireEvent.click(screen.getByTestId(`dock-tab-${WEB.id}`));

  expect(useDock.getState().minimized).toBe(false);
});

test("resize handle updates height", async () => {
  useDock.getState().open(WEB);
  useDock.getState().setHeight(300);
  await show();
  const handle = screen.getByTestId("dock-resize");
  expect(screen.getByTestId("dock").style.height).toBe("300px");

  fireEvent.pointerDown(handle, { clientY: 500, pointerId: 1 });
  fireEvent.pointerMove(handle, { clientY: 400, pointerId: 1 });
  expect(useDock.getState().height).toBe(400);
  expect(screen.getByTestId("dock").style.height).toBe("400px");

  fireEvent.pointerMove(handle, { clientY: 450, pointerId: 1 });
  expect(useDock.getState().height).toBe(350);

  fireEvent.pointerUp(handle, { clientY: 450, pointerId: 1 });
  fireEvent.pointerMove(handle, { clientY: 100, pointerId: 1 });
  expect(useDock.getState().height).toBe(350);
});

test("the resize handle works from the keyboard", async () => {
  useDock.getState().open(WEB);
  useDock.getState().setHeight(300);
  await show();
  const handle = screen.getByRole("separator", { name: "Resize dock" });

  fireEvent.keyDown(handle, { key: "ArrowUp" });
  expect(useDock.getState().height).toBeGreaterThan(300);

  act(() => useDock.getState().setHeight(300));
  fireEvent.keyDown(handle, { key: "ArrowDown" });
  expect(useDock.getState().height).toBeLessThan(300);
});

test("the dock shows only the current cluster's tabs", async () => {
  useDock.getState().open(WEB);
  useDock.getState().open(OTHER);
  useDock.getState().open(newCreateTab("c2"));
  await show("c1");

  expect(screen.getByTestId(`dock-tab-${WEB.id}`)).toBeTruthy();
  expect(screen.queryByTestId(`dock-tab-${OTHER.id}`)).toBeNull();
  expect(screen.queryAllByRole("tab")).toHaveLength(1);
  // The active tab is another cluster's, so this cluster's own tab is shown.
  expect(panel(WEB.id).hidden).toBe(false);
});

test("unsaved edits come back with their cluster", async () => {
  useDock.getState().open(WEB);
  const view = await show("c1");
  fireEvent.change(editorOf(WEB.id), { target: { value: "edited: true\n" } });

  view.unmount();
  useDock.getState().open(OTHER);
  const second = await show("c2");
  expect(screen.queryByTestId(`dock-tab-${WEB.id}`)).toBeNull();

  second.unmount();
  await show("c1");
  expect(editorOf(WEB.id).value).toBe("edited: true\n");
  expect(screen.getByTestId(`dock-tab-${WEB.id}`).dataset.dirty).toBe("true");
});
