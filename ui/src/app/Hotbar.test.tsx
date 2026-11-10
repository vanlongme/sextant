import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ClusterEntry } from "../ipc/generated/ClusterEntry";
import { resetCatalogForTest, useCatalog } from "../stores/catalog";
import { resetShellForTest, useShell } from "../stores/shell";
import { clusterEntry, flush, mockBackend } from "../test/ipc";
import { Hotbar } from "./Hotbar";

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>;
}

const alpha = clusterEntry({ id: "a", contextName: "prod-eu-west" });
const beta = clusterEntry({
  id: "b",
  contextName: "kind-e2e",
  state: { status: "connecting" },
});

async function show(clusters: ClusterEntry[], hotbar: string[]) {
  const ipc = mockBackend({
    catalog_list: () => clusters,
    catalog_warnings: () => [],
    hotbar_get: () => hotbar,
    hotbar_set: () => null,
  });
  await useCatalog.getState().init();
  render(
    <MemoryRouter initialEntries={["/catalog"]}>
      <Hotbar />
      <Where />
    </MemoryRouter>,
  );
  return ipc;
}

function shownOrder(): (string | null)[] {
  return within(screen.getByTestId("hotbar"))
    .getAllByRole("button")
    .map((el) => el.getAttribute("data-testid"))
    .filter((id) => id?.startsWith("hotbar-item-")) as string[];
}

beforeEach(() => {
  resetCatalogForTest();
  resetShellForTest();
});
afterEach(() => vi.restoreAllMocks());

test("renders pinned clusters with initials and status dot", async () => {
  await show([alpha, beta], ["b", "a"]);

  expect(shownOrder()).toEqual(["hotbar-item-b", "hotbar-item-a"]);
  const first = within(screen.getByTestId("hotbar-item-a"));
  expect(first.getByText("PE")).toBeTruthy();
  expect(first.getByRole("img", { name: "Disconnected" })).toBeTruthy();
  expect(
    within(screen.getByTestId("hotbar-item-b")).getByRole("img", {
      name: "Connecting",
    }),
  ).toBeTruthy();
});

test("shows the user's icon when the cluster has one", async () => {
  const withIcon = clusterEntry({
    id: "i",
    icon: "data:image/png;base64,AAAA",
  });
  await show([withIcon], ["i"]);

  const item = within(screen.getByTestId("hotbar-item-i"));
  expect(item.getByRole("presentation").getAttribute("src")).toBe(
    "data:image/png;base64,AAAA",
  );
});

test("rail links keep their class and mark the current page", async () => {
  await show([], []);

  const catalog = screen.getByTestId("nav-catalog");
  expect(catalog.classList.contains("link")).toBe(true);
  expect(catalog.getAttribute("aria-current")).toBe("page");
  expect(
    screen.getByTestId("nav-preferences").getAttribute("aria-current"),
  ).toBeNull();
});

test("click navigates to the cluster", async () => {
  await show([alpha], ["a"]);

  fireEvent.click(screen.getByTestId("hotbar-item-a"));

  expect(screen.getByTestId("where").textContent).toBe("/cluster/a");
});

test("unknown ids are not rendered", async () => {
  await show([alpha], ["ghost", "a"]);

  expect(shownOrder()).toEqual(["hotbar-item-a"]);
});

test("explains itself when nothing is pinned", async () => {
  await show([alpha], []);

  expect(
    screen.getByRole("img", { name: /Pin clusters from the catalog/ }),
  ).toBeTruthy();
});

test("keyboard reorder calls reorderHotbar", async () => {
  // jsdom has no layout, so give each item the place it would have on screen.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const items = shownOrder();
      const index = items.indexOf(this.getAttribute("data-testid"));
      const holder = items.findIndex(
        (id) => id && this.querySelector(`[data-testid="${id}"]`),
      );
      const at = index >= 0 ? index : Math.max(holder, 0);
      return new DOMRect(0, at * 48, 40, 40);
    },
  );
  const ipc = await show([alpha, beta], ["a", "b"]);
  const item = screen.getByTestId("hotbar-item-a");
  item.focus();

  fireEvent.keyDown(item, { code: "Space", key: " " });
  await act(flush);
  fireEvent.keyDown(document, { code: "ArrowDown", key: "ArrowDown" });
  await act(flush);
  fireEvent.keyDown(document, { code: "Space", key: " " });
  await act(flush);

  await waitFor(() =>
    expect(ipc.callsTo("hotbar_set")).toEqual([{ ids: ["b", "a"] }]),
  );
  expect(useCatalog.getState().hotbar).toEqual(["b", "a"]);
  expect(screen.getByTestId("where").textContent).toBe("/catalog");
});

test("unpin from the context menu", async () => {
  const ipc = await show([alpha, beta], ["a", "b"]);

  fireEvent.contextMenu(screen.getByTestId("hotbar-item-a"));
  fireEvent.click(await screen.findByTestId("menu-item-unpin"));

  await waitFor(() =>
    expect(ipc.callsTo("hotbar_set")).toEqual([{ ids: ["b"] }]),
  );
  await waitFor(() => expect(shownOrder()).toEqual(["hotbar-item-b"]));
  expect(screen.getByTestId("where").textContent).toBe("/catalog");
});

test("a long non-ASCII name stays on one line in the tooltip, in full", async () => {
  const name = "クラスター".repeat(60);
  await show([clusterEntry({ id: "l", contextName: "long", name })], ["l"]);
  const item = screen.getByTestId("hotbar-item-l");

  expect(item.getAttribute("aria-label")).toBe(name);
  fireEvent.focus(item);

  const tip = await screen.findByRole("tooltip");
  expect(tip.textContent).toBe(name);
  const label = document.querySelector(`span[title="${name}"]`);
  expect(label).not.toBeNull();
  const style = getComputedStyle(label as Element);
  expect(style.textOverflow).toBe("ellipsis");
  expect(style.whiteSpace).toBe("nowrap");
});

test("the Help menu sits directly above Preferences and lists three items", async () => {
  await show([alpha], []);

  const help = screen.getByTestId("hotbar-help");
  expect(help.getAttribute("aria-label")).toBe("Help");
  expect(help.nextElementSibling?.getAttribute("data-testid")).toBe(
    "nav-preferences",
  );
  fireEvent.keyDown(help, { key: "Enter" });
  const items = await screen.findAllByRole("menuitem");
  expect(
    items.map((item) => [item.getAttribute("data-testid"), item.textContent]),
  ).toEqual([
    ["help-palette", "Command palette"],
    ["help-shortcuts", "Keyboard shortcuts"],
    ["help-about", "About SkoposIDE"],
  ]);
});

test("the Help menu's items open the three shell dialogs", async () => {
  await show([alpha], []);

  const opened: (string | null)[] = [];
  for (const item of ["help-palette", "help-shortcuts", "help-about"]) {
    fireEvent.keyDown(screen.getByTestId("hotbar-help"), { key: "Enter" });
    fireEvent.click(await screen.findByTestId(item));
    opened.push(useShell.getState().dialog);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  }
  expect(opened).toEqual(["palette", "shortcuts", "about"]);
});
