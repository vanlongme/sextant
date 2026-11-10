import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, expect, test } from "vitest";
import type { ClusterEntry } from "../../ipc/generated/ClusterEntry";
import { resetCatalogForTest, useCatalog } from "../../stores/catalog";
import { resetShellForTest, useShell } from "../../stores/shell";
import { clusterEntry, emitEvent, mockBackend } from "../../test/ipc";
import { CatalogScreen } from "./CatalogScreen";

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>;
}

async function show(
  clusters: ClusterEntry[],
  over: Record<string, (args: never) => unknown> = {},
) {
  const ipc = mockBackend({
    catalog_list: () => clusters,
    catalog_warnings: () => [],
    hotbar_get: () => [],
    hotbar_set: () => null,
    ...over,
  });
  await useCatalog.getState().init();
  render(
    <MemoryRouter initialEntries={["/catalog"]}>
      <CatalogScreen />
      <Where />
    </MemoryRouter>,
  );
  return ipc;
}

function openRowMenu(context: string) {
  fireEvent.keyDown(screen.getByTestId(`catalog-menu-${context}`), {
    key: "Enter",
  });
}

beforeEach(() => {
  resetCatalogForTest();
  resetShellForTest();
});

test("empty catalog explains how to add a cluster", async () => {
  await show([]);

  expect(screen.getByText(/~\/\.kube/)).toBeTruthy();
  expect(screen.queryByTestId("catalog-add")).toBeNull();
  expect(screen.queryByRole("table")).toBeNull();
});

test("lists clusters and filters by search", async () => {
  await show([
    clusterEntry({ contextName: "alpha" }),
    clusterEntry({ contextName: "beta" }),
  ]);
  expect(screen.getByTestId("catalog-row-alpha")).toBeTruthy();
  expect(screen.getByTestId("catalog-row-beta")).toBeTruthy();

  fireEvent.change(screen.getByTestId("catalog-search"), {
    target: { value: "BET" },
  });

  expect(screen.queryByTestId("catalog-row-alpha")).toBeNull();
  expect(screen.getByTestId("catalog-row-beta")).toBeTruthy();

  fireEvent.change(screen.getByTestId("catalog-search"), {
    target: { value: "nothing-like-this" },
  });
  const noMatch = screen.getByText(/No clusters match/);
  expect(noMatch).toBeTruthy();
  // The empty state is its own card, so it must not sit inside the table card.
  expect(noMatch.closest(".table")).toBeNull();
});

test("shows the source basename with the full path in its title", async () => {
  await show([
    clusterEntry({
      contextName: "alpha",
      source: { kind: "synced", path: "/home/me/.kube/work.yaml" },
    }),
  ]);

  const source = screen.getByText("work.yaml");
  expect(source.getAttribute("title")).toBe("/home/me/.kube/work.yaml");
});

test("shows distribution and status for a connected cluster", async () => {
  await show([
    clusterEntry({
      contextName: "alpha",
      state: {
        status: "connected",
        info: {
          version: "v1",
          distribution: "kind",
          nodeCount: 1,
          namespaces: [],
          namespacesRestricted: false,
          isAdmin: true,
        },
      },
    }),
  ]);

  const row = within(screen.getByTestId("catalog-row-alpha"));
  expect(row.getByText("kind")).toBeTruthy();
  expect(row.getByText("Connected")).toBeTruthy();
  expect(row.getByRole("img", { name: "Connected" })).toBeTruthy();
});

test("shows the problem on a broken context and disables connect", async () => {
  await show([
    clusterEntry({ contextName: "broken", problem: 'user "x" is missing' }),
  ]);

  const row = within(screen.getByTestId("catalog-row-broken"));
  expect(row.getByText(/user "x" is missing/)).toBeTruthy();
  const connect = row.getByRole("button", {
    name: "Connect",
  }) as HTMLButtonElement;
  expect(connect.disabled).toBe(true);
});

test("shows why a connection failed", async () => {
  await show([
    clusterEntry({
      contextName: "dead",
      state: { status: "failed", kind: "unreachable", message: "refused" },
    }),
  ]);

  expect(screen.getByText(/refused/)).toBeTruthy();
});

test("connect and disconnect call the backend without opening the row", async () => {
  const ipc = await show(
    [
      clusterEntry({ id: "a", contextName: "alpha" }),
      clusterEntry({
        id: "b",
        contextName: "beta",
        state: {
          status: "connected",
          info: {
            version: "v1",
            distribution: "kind",
            nodeCount: 1,
            namespaces: [],
            namespacesRestricted: false,
            isAdmin: true,
          },
        },
      }),
    ],
    {
      cluster_connect: () => ({ status: "connecting" }),
      cluster_disconnect: () => null,
    },
  );

  fireEvent.click(
    within(screen.getByTestId("catalog-row-alpha")).getByRole("button", {
      name: "Connect",
    }),
  );
  fireEvent.click(
    within(screen.getByTestId("catalog-row-beta")).getByRole("button", {
      name: "Disconnect",
    }),
  );

  await waitFor(() => {
    expect(ipc.callsTo("cluster_connect")).toEqual([{ id: "a" }]);
    expect(ipc.callsTo("cluster_disconnect")).toEqual([{ id: "b" }]);
  });
  expect(screen.getByTestId("where").textContent).toBe("/catalog");
});

test("a connect in flight can be cancelled by disconnecting", async () => {
  const ipc = await show([clusterEntry({ id: "a", contextName: "alpha" })], {
    cluster_connect: () => new Promise(() => {}),
    cluster_disconnect: () => null,
  });

  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await emitEvent("cluster://state", {
    id: "a",
    state: { status: "connecting" },
  });

  const disconnect = screen.getByRole("button", {
    name: "Disconnect",
  }) as HTMLButtonElement;
  expect(disconnect.disabled).toBe(false);
  fireEvent.click(disconnect);

  await waitFor(() =>
    expect(ipc.callsTo("cluster_disconnect")).toEqual([{ id: "a" }]),
  );
});

test("a failed connect shows the backend's message", async () => {
  await show([clusterEntry({ contextName: "alpha" })], {
    cluster_connect: () => {
      throw { code: "NotFound", message: "no cluster id-alpha", details: null };
    },
  });
  const { Toaster } = await import("../../design");
  render(<Toaster />);

  fireEvent.click(screen.getByRole("button", { name: "Connect" }));

  expect(await screen.findByText(/no cluster id-alpha/)).toBeTruthy();
});

test("clicking a row opens the cluster", async () => {
  await show([clusterEntry({ id: "a", contextName: "alpha" })]);

  fireEvent.click(screen.getByTestId("catalog-row-alpha"));

  expect(screen.getByTestId("where").textContent).toBe("/cluster/a");
});

test("long_cluster_name_is_truncated_with_full_title", async () => {
  const name = "クラスター".repeat(60);
  expect(name).toHaveLength(300);
  await show([clusterEntry({ contextName: "long", name })]);

  const cell = within(screen.getByTestId("catalog-row-long")).getByRole("link");

  expect(cell.getAttribute("title")).toBe(name);
  const style = getComputedStyle(cell);
  expect(style.textOverflow).toBe("ellipsis");
  expect(style.whiteSpace).toBe("nowrap");
  expect(style.overflow).toBe("hidden");
});

test("add cluster dialog pastes YAML and reports invalid input", async () => {
  let reject = true;
  const ipc = await show([], {
    catalog_add_pasted: () => {
      if (reject) {
        throw {
          code: "InvalidInput",
          message: "no contexts in this text",
          details: null,
        };
      }
      return ["new-id"];
    },
  });

  act(() => useShell.getState().openAddCluster());
  const dialog = within(await screen.findByRole("dialog"));
  fireEvent.change(dialog.getByTestId("catalog-add-yaml"), {
    target: { value: "not: a kubeconfig" },
  });
  fireEvent.click(dialog.getByTestId("catalog-add-submit"));

  expect(await dialog.findByText("no contexts in this text")).toBeTruthy();
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(ipc.callsTo("catalog_add_pasted")).toEqual([
    { yaml: "not: a kubeconfig" },
  ]);

  reject = false;
  fireEvent.click(dialog.getByTestId("catalog-add-submit"));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("add cluster needs some text first", async () => {
  await show([]);

  act(() => useShell.getState().openAddCluster());
  const dialog = within(await screen.findByRole("dialog"));

  const submit = dialog.getByTestId("catalog-add-submit") as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
});

test("remove only offered for pasted clusters", async () => {
  const ipc = await show(
    [
      clusterEntry({ id: "s", contextName: "synced" }),
      clusterEntry({
        id: "p",
        contextName: "pasted",
        source: { kind: "pasted", path: "/data/pasted/abc.yaml" },
      }),
    ],
    { catalog_remove_pasted: () => null },
  );

  openRowMenu("synced");
  await screen.findByTestId("menu-item-pin");
  expect(screen.queryByTestId("menu-item-remove")).toBeNull();
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

  openRowMenu("pasted");
  fireEvent.click(await screen.findByTestId("menu-item-remove"));

  const dialog = within(await screen.findByRole("dialog"));
  expect(dialog.getByText("pasted", { selector: "strong" })).toBeTruthy();
  expect(ipc.callsTo("catalog_remove_pasted")).toEqual([]);
  fireEvent.click(dialog.getByRole("button", { name: "Remove" }));

  await waitFor(() =>
    expect(ipc.callsTo("catalog_remove_pasted")).toEqual([{ id: "p" }]),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByTestId("where").textContent).toBe("/catalog");
});

test("pin and unpin from the row menu", async () => {
  const ipc = await show([clusterEntry({ id: "a", contextName: "alpha" })]);

  openRowMenu("alpha");
  fireEvent.click(await screen.findByTestId("menu-item-pin"));
  await waitFor(() =>
    expect(ipc.callsTo("hotbar_set")).toEqual([{ ids: ["a"] }]),
  );
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

  openRowMenu("alpha");
  fireEvent.click(await screen.findByTestId("menu-item-unpin"));
  await waitFor(() =>
    expect(ipc.callsTo("hotbar_set")).toEqual([{ ids: ["a"] }, { ids: [] }]),
  );
  expect(screen.getByTestId("where").textContent).toBe("/catalog");
});

test("warnings are visible", async () => {
  await show([clusterEntry({ contextName: "alpha" })], {
    catalog_warnings: () => [
      { path: "/home/me/.kube/broken", message: "did not parse: bad indent" },
    ],
  });

  const banner = screen.getByTestId("catalog-warnings");
  expect(banner.textContent).toContain("/home/me/.kube/broken");
  expect(banner.textContent).toContain("did not parse: bad indent");
});

test("shows loading and error states", async () => {
  let fail = true;
  mockBackend({
    catalog_list: () => {
      if (fail) throw { code: "Internal", message: "broken", details: null };
      return [clusterEntry({ contextName: "alpha" })];
    },
    catalog_warnings: () => [],
    hotbar_get: () => [],
  });
  const view = render(
    <MemoryRouter>
      <CatalogScreen />
    </MemoryRouter>,
  );
  expect(screen.getByRole("status", { name: "Loading" })).toBeTruthy();

  await useCatalog.getState().init();
  expect(await screen.findByText("broken")).toBeTruthy();

  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByTestId("catalog-row-alpha")).toBeTruthy();
  view.unmount();
});
