import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { Circle } from "lucide-react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Toaster } from "../../design";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import type { WatchEvent } from "../../ipc/generated/WatchEvent";
import type { KubeObject } from "../../kinds/objects";
import { type DeleteDialogProps, registerKind } from "../../kinds/registry";
import { resetDockForTest, useDock } from "../../stores/dock";
import { resetResourcesForTest } from "../../stores/resources";
import { flush, mockBackend } from "../../test/ipc";
import { mockElementSize } from "../../test/size";
import { ResourceRoute, ResourceScreen } from "./ResourceScreen";

function info(
  resource: Partial<ResourceRef>,
  over: Partial<ApiResourceInfo> = {},
): ApiResourceInfo {
  return {
    resource: {
      group: "",
      version: "v1",
      plural: "pods",
      kind: "Pod",
      namespaced: true,
      ...resource,
    },
    verbs: ["list", "watch", "delete"],
    shortNames: [],
    canList: true,
    canWatch: true,
    canCreate: true,
    canUpdate: true,
    canPatch: true,
    canDelete: true,
    ...over,
  };
}

const PODS = info({});
const NODES = info({ plural: "nodes", kind: "Node", namespaced: false });
const DEPLOYMENTS = info({
  group: "apps",
  plural: "deployments",
  kind: "Deployment",
});
const CRDS = info({
  group: "apiextensions.k8s.io",
  plural: "customresourcedefinitions",
  kind: "CustomResourceDefinition",
  namespaced: false,
});
const WIDGETS = info({
  group: "example.com",
  plural: "widgets",
  kind: "Widget",
});

function pod(name: string, namespace = "default"): KubeObject {
  return { metadata: { name, namespace, resourceVersion: "1" } };
}

/** The saved UI state and the live subscriptions of one fake backend. */
function fakeBackend(
  over: {
    uiState?: Record<string, unknown>;
    subscribe?(resource: ResourceRef): void;
    resourceDelete?(args: {
      name: string;
      namespace: string | null;
      propagation: string;
    }): unknown;
  } = {},
) {
  const uiState = over.uiState ?? {};
  const subs = new Map<string, (event: WatchEvent) => void>();
  const backend = mockBackend({
    ui_state_get: (a: { key: string }) => uiState[a.key] ?? null,
    ui_state_set: (a: { key: string; value: unknown }) => {
      uiState[a.key] = a.value;
      return null;
    },
    resources_subscribe: (a: {
      resource: ResourceRef;
      onEvent: { onmessage: (e: WatchEvent) => void };
    }) => {
      over.subscribe?.(a.resource);
      subs.set(a.resource.plural, a.onEvent.onmessage);
      return `sub-${a.resource.plural}`;
    },
    resources_unsubscribe: () => null,
    resource_delete: (a: {
      name: string;
      namespace: string | null;
      propagation: string;
    }) => (over.resourceDelete ? over.resourceDelete(a) : null),
  });
  async function send(plural: string, event: WatchEvent) {
    await act(async () => {
      subs.get(plural)?.(event);
      await flush();
    });
  }
  return { backend, uiState, subs, send };
}

type Fake = ReturnType<typeof fakeBackend>;

function screenFor(
  clusterId: string,
  resource: ApiResourceInfo,
  resources: ApiResourceInfo[],
) {
  return (
    <MemoryRouter>
      <ResourceScreen
        key={`${clusterId}/${resource.resource.plural}`}
        clusterId={clusterId}
        info={resource}
        resources={resources}
      />
      <Toaster />
    </MemoryRouter>
  );
}

/** Shows a screen and delivers its first rows. */
async function show(
  fake: Fake,
  items: KubeObject[],
  resource: ApiResourceInfo = PODS,
  clusterId = "c1",
  resources: ApiResourceInfo[] = [resource],
) {
  const view = render(screenFor(clusterId, resource, resources));
  await act(flush);
  await fake.send(resource.resource.plural, {
    type: "snapshot",
    items,
  } as WatchEvent);
  await fake.send(resource.resource.plural, {
    type: "status",
    status: "live",
    message: null,
  });
  return view;
}

const row = (namespace: string, name: string) =>
  screen.queryByTestId(`resource-row-${namespace}-${name}`);

function openMenu(testId: string) {
  fireEvent.keyDown(screen.getByTestId(testId), { key: "Enter" });
}

function closeMenu() {
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
}

/** Lets a debounced UI state write reach the fake backend. */
async function savedKeys(fake: Fake, count: number) {
  await waitFor(() =>
    expect(Object.keys(fake.uiState).length).toBeGreaterThanOrEqual(count),
  );
}

beforeEach(() => {
  resetResourcesForTest();
  mockElementSize();
});
afterEach(() => {
  resetResourcesForTest();
  vi.restoreAllMocks();
});

test("shows loading, then rows, then empty text with the namespace filter's context", async () => {
  const fake = fakeBackend();
  const { unmount } = render(screenFor("c1", PODS, [PODS]));
  await act(flush);
  expect(screen.getByRole("status", { name: /Loading/ })).toBeTruthy();
  expect(screen.queryByTestId("resource-table")).toBeNull();

  await fake.send("pods", {
    type: "snapshot",
    items: [pod("web", "team-a")],
  } as WatchEvent);
  expect(screen.queryByRole("status", { name: /Loading/ })).toBeNull();
  expect(row("team-a", "web")).toBeTruthy();
  expect(screen.getByTestId("resource-table")).toBeTruthy();

  await fake.send("pods", {
    type: "batch",
    upserts: [],
    deletes: [{ namespace: "team-a", name: "web" }],
  });
  expect(screen.queryByTestId("resource-table")).toBeNull();
  expect(screen.getByText(/no Pod objects in any namespace/i)).toBeTruthy();
  unmount();

  const scoped = fakeBackend({ uiState: { "namespaces:c1": ["team-a"] } });
  resetResourcesForTest();
  await show(scoped, []);
  expect(
    await screen.findByText(/no Pod objects in namespace team-a/i),
  ).toBeTruthy();
});

test("namespace filter persists per cluster and limits rows", async () => {
  const fake = fakeBackend();
  const items = [pod("a", "team-a"), pod("b", "team-b"), pod("c", "team-c")];
  const first = await show(fake, items);

  openMenu("namespace-filter");
  fireEvent.click(screen.getByTestId("namespace-option-team-a"));
  expect(row("team-a", "a")).toBeTruthy();
  expect(row("team-b", "b")).toBeNull();

  // It is a multi-select: the menu stays open and another namespace adds to it.
  fireEvent.click(screen.getByTestId("namespace-option-team-b"));
  expect(row("team-a", "a")).toBeTruthy();
  expect(row("team-b", "b")).toBeTruthy();
  expect(row("team-c", "c")).toBeNull();
  closeMenu();
  expect(screen.getByTestId("namespace-filter").textContent).toContain(
    "2 namespaces",
  );
  await savedKeys(fake, 1);
  first.unmount();
  resetResourcesForTest();

  // Coming back to this cluster, on another kind too, keeps the choice.
  const again = await show(fake, [pod("d", "team-b"), pod("e", "team-c")], {
    ...DEPLOYMENTS,
  });
  await waitFor(() => expect(row("team-c", "e")).toBeNull());
  expect(row("team-b", "d")).toBeTruthy();
  again.unmount();
  resetResourcesForTest();

  // Another cluster has its own.
  await show(fake, items, PODS, "c2");
  await act(flush);
  expect(row("team-c", "c")).toBeTruthy();
  expect(screen.getByTestId("namespace-filter").textContent).toContain(
    "All namespaces",
  );
});

test("All namespaces is the default and cluster-scoped kinds have no filter", async () => {
  const fake = fakeBackend();
  const first = await show(fake, [pod("a", "team-a"), pod("b", "team-b")]);
  const filter = screen.getByTestId("namespace-filter");
  expect(filter.textContent).toContain("All namespaces");
  expect(row("team-a", "a")).toBeTruthy();
  expect(row("team-b", "b")).toBeTruthy();

  // Choosing a namespace and then All shows everything again.
  openMenu("namespace-filter");
  fireEvent.click(screen.getByTestId("namespace-option-team-a"));
  expect(row("team-b", "b")).toBeNull();
  fireEvent.click(screen.getByTestId("namespace-all"));
  expect(row("team-b", "b")).toBeTruthy();
  closeMenu();
  first.unmount();
  resetResourcesForTest();

  await show(fake, [{ metadata: { name: "node-1" } }], NODES);
  expect(screen.queryByTestId("namespace-filter")).toBeNull();
  expect(screen.getByTestId("resource-row-node-1")).toBeTruthy();
  expect(screen.queryByRole("columnheader", { name: "Namespace" })).toBeNull();
});

test("a saved namespace with no objects can still be cleared", async () => {
  const fake = fakeBackend({ uiState: { "namespaces:c1": ["gone"] } });
  await show(fake, [pod("a", "team-a")]);
  await waitFor(() => expect(row("team-a", "a")).toBeNull());
  openMenu("namespace-filter");
  fireEvent.click(screen.getByTestId("namespace-option-gone"));
  expect(row("team-a", "a")).toBeTruthy();
});

test("column visibility persists per kind", async () => {
  const fake = fakeBackend();
  const first = await show(fake, [pod("a")]);
  expect(screen.getByRole("columnheader", { name: /Age/ })).toBeTruthy();

  openMenu("columns-menu");
  fireEvent.click(screen.getByTestId("column-option-age"));
  closeMenu();
  expect(screen.queryByRole("columnheader", { name: /Age/ })).toBeNull();
  await savedKeys(fake, 1);
  first.unmount();
  resetResourcesForTest();

  // Same kind on another cluster: still hidden.
  const again = await show(fake, [pod("a")], PODS, "c2");
  await waitFor(() =>
    expect(screen.queryByRole("columnheader", { name: /Age/ })).toBeNull(),
  );
  openMenu("columns-menu");
  expect(
    screen.getByTestId("column-option-age").getAttribute("aria-checked"),
  ).toBe("false");
  closeMenu();
  again.unmount();
  resetResourcesForTest();

  // Another kind: shown.
  await show(fake, [pod("a")], DEPLOYMENTS);
  await act(flush);
  expect(screen.getByRole("columnheader", { name: /Age/ })).toBeTruthy();
});

test("search filters rows", async () => {
  const fake = fakeBackend();
  await show(fake, [
    { metadata: { name: "web", namespace: "a", labels: { app: "web" } } },
    { metadata: { name: "db", namespace: "a", labels: { app: "sql" } } },
  ]);
  const search = screen.getByTestId("resource-search");
  fireEvent.change(search, { target: { value: "app=sql" } });
  expect(row("a", "web")).toBeNull();
  expect(row("a", "db")).toBeTruthy();

  fireEvent.change(search, { target: { value: "absent" } });
  expect(screen.getByText(/match "absent"/)).toBeTruthy();

  fireEvent.change(search, { target: { value: "" } });
  expect(row("a", "web")).toBeTruthy();
});

test("the sort survives a search that matches nothing", async () => {
  const fake = fakeBackend();
  await show(fake, [
    { metadata: { name: "b", namespace: "a", labels: { app: "web" } } },
    { metadata: { name: "c", namespace: "a", labels: { app: "web" } } },
    { metadata: { name: "a", namespace: "a", labels: { app: "web" } } },
  ]);
  const shownNames = () =>
    screen
      .getAllByTestId(/^resource-row-/)
      .map((el) => (el.dataset.testid ?? "").replace("resource-row-a-", ""));
  fireEvent.click(screen.getByRole("button", { name: "Name" }));
  fireEvent.click(screen.getByRole("button", { name: "Name" }));
  expect(shownNames()).toEqual(["c", "b", "a"]);

  // Typing "app=web" passes through "app=", which only an empty label value matches.
  const search = screen.getByTestId("resource-search");
  fireEvent.change(search, { target: { value: "app=" } });
  expect(screen.queryByTestId("resource-table")).toBeNull();

  fireEvent.change(search, { target: { value: "app=web" } });
  expect(shownNames()).toEqual(["c", "b", "a"]);
  expect(
    screen
      .getByRole("columnheader", { name: "Name" })
      .getAttribute("aria-sort"),
  ).toBe("descending");

  fireEvent.change(search, { target: { value: "" } });
  expect(shownNames()).toEqual(["c", "b", "a"]);
});

test("reconnecting shows an indicator and keeps rows", async () => {
  const fake = fakeBackend();
  await show(fake, [pod("a")]);
  expect(screen.queryByTestId("resource-status")).toBeNull();

  await fake.send("pods", {
    type: "status",
    status: "reconnecting",
    message: "connection lost",
  });
  expect(screen.getByTestId("resource-status").textContent).toMatch(
    /reconnecting/i,
  );
  expect(row("default", "a")).toBeTruthy();

  await fake.send("pods", { type: "status", status: "live", message: null });
  expect(screen.queryByTestId("resource-status")).toBeNull();
  expect(row("default", "a")).toBeTruthy();
});

test("not served and forbidden show an explanation instead of a table", async () => {
  const fake = fakeBackend();
  const first = await show(fake, [pod("a")]);
  await fake.send("pods", {
    type: "status",
    status: "notServed",
    message: null,
  });
  expect(screen.queryByTestId("resource-table")).toBeNull();
  expect(screen.getByTestId("resource-status").textContent).toMatch(
    /no longer serves/,
  );
  first.unmount();
  resetResourcesForTest();

  const denied = fakeBackend();
  await show(denied, [pod("a")]);
  await denied.send("pods", {
    type: "status",
    status: "forbidden",
    message: 'pods is forbidden: User "me" cannot list',
  });
  expect(screen.queryByTestId("resource-table")).toBeNull();
  expect(screen.getByTestId("resource-status").textContent).toContain(
    'pods is forbidden: User "me" cannot list',
  );
});

test("a refused subscribe shows its reason, not that the type is gone", async () => {
  mockBackend({
    ui_state_get: () => null,
    resources_subscribe: () =>
      Promise.reject({
        code: "Unreachable",
        message: "the cluster is not connected",
        details: null,
      }),
  });
  render(screenFor("c1", PODS, [PODS]));
  await act(flush);
  const status = await screen.findByTestId("resource-status");
  expect(status.textContent).toContain("the cluster is not connected");
  expect(status.textContent).not.toMatch(/no longer serves/);
  expect(screen.queryByRole("status", { name: /Loading/ })).toBeNull();
});

test("bulk delete confirms with the names and count and reports each failure", async () => {
  const deleted: unknown[] = [];
  const fake = fakeBackend({
    resourceDelete: (a) => {
      deleted.push(a);
      if (a.name === "ok") return null;
      return Promise.reject({
        code: "Forbidden",
        message: `${a.name} cannot be deleted by you`,
        details: null,
      });
    },
  });
  await show(fake, [pod("ok"), pod("bad1"), pod("bad2"), pod("left")]);
  const bulk = screen.getByTestId("bulk-delete") as HTMLButtonElement;
  expect(bulk.disabled).toBe(true);

  for (const name of ["ok", "bad1", "bad2"]) {
    fireEvent.click(
      screen.getByRole("checkbox", { name: `Select default/${name}` }),
    );
  }
  expect(bulk.disabled).toBe(false);
  expect(bulk.textContent).toContain("3");
  fireEvent.click(bulk);

  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText(/Delete 3 Pod objects/)).toBeTruthy();
  for (const name of ["ok", "bad1", "bad2"]) {
    expect(within(dialog).getByText(`default/${name}`)).toBeTruthy();
  }
  expect(within(dialog).queryByText("default/left")).toBeNull();
  expect(deleted).toEqual([]);

  fireEvent.click(screen.getByTestId("delete-confirm"));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  expect(deleted).toHaveLength(3);
  expect(deleted).toContainEqual(
    expect.objectContaining({
      name: "ok",
      namespace: "default",
      propagation: "background",
    }),
  );
  const toast = await screen.findByText(/Could not delete 2 of 3 Pod objects/);
  const details = toast.parentElement?.textContent ?? "";
  expect(details).toContain("default/bad1: bad1 cannot be deleted by you");
  expect(details).toContain("default/bad2: bad2 cannot be deleted by you");

  // What failed stays selected, so it can be tried again.
  expect(bulk.textContent).toContain("2");
});

test("a bulk delete with many failures reports each one in a toast that can be read", async () => {
  const names = Array.from({ length: 60 }, (_, i) => `pod-${i}`);
  const fake = fakeBackend({
    resourceDelete: (a) =>
      Promise.reject({
        code: "Forbidden",
        message: `${a.name} cannot be deleted by you`,
        details: null,
      }),
  });
  await show(
    fake,
    names.map((name) => pod(name)),
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "Select all rows" }));
  fireEvent.click(screen.getByTestId("bulk-delete"));
  fireEvent.click(screen.getByTestId("delete-confirm"));

  const title = await screen.findByText(
    /Could not delete 60 of 60 Pod objects/,
  );
  const details = title.nextElementSibling as HTMLElement;
  for (const name of names) {
    expect(details.textContent).toContain(
      `default/${name}: ${name} cannot be deleted by you`,
    );
  }
  expect(getComputedStyle(details).overflowY).toBe("auto");
  expect(getComputedStyle(details).maxHeight).not.toBe("none");

  const toast = title.parentElement as HTMLElement;
  fireEvent.click(within(toast).getByRole("button", { name: "Dismiss" }));
  await waitFor(() => expect(screen.queryByText(/of 60 Pod/)).toBeNull());
});

test("a bulk delete only takes the rows still shown", async () => {
  const deleted: string[] = [];
  const fake = fakeBackend({
    resourceDelete: (a) => {
      deleted.push(a.name);
      return null;
    },
  });
  await show(fake, [pod("web"), pod("db")]);
  fireEvent.click(screen.getByRole("checkbox", { name: "Select all rows" }));
  fireEvent.change(screen.getByTestId("resource-search"), {
    target: { value: "web" },
  });
  fireEvent.click(screen.getByTestId("bulk-delete"));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).queryByText("default/db")).toBeNull();
  fireEvent.click(screen.getByTestId("delete-confirm"));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(deleted).toEqual(["web"]);
});

test("row delete offers propagation for owners and shows the API error in a toast", async () => {
  const calls: unknown[] = [];
  const fake = fakeBackend({
    resourceDelete: (a) => {
      calls.push(a);
      return Promise.reject({
        code: "Forbidden",
        message: "deployments.apps is forbidden",
        details: null,
      });
    },
  });
  await show(fake, [pod("web", "team-a")], DEPLOYMENTS);

  openMenu("row-menu-web");
  fireEvent.click(screen.getByTestId("menu-item-delete"));
  const dialog = await screen.findByRole("dialog");
  expect(
    within(dialog).getByText(/Delete Deployment team-a\/web/),
  ).toBeTruthy();
  expect(
    (screen.getByRole("radio", { name: /Background/ }) as HTMLInputElement)
      .checked,
  ).toBe(true);
  fireEvent.click(screen.getByRole("radio", { name: /Orphan/ }));

  // Cancelling sends nothing.
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(calls).toEqual([]);

  openMenu("row-menu-web");
  fireEvent.click(screen.getByTestId("menu-item-delete"));
  await screen.findByRole("dialog");
  fireEvent.click(screen.getByRole("radio", { name: /Foreground/ }));
  fireEvent.click(screen.getByTestId("delete-confirm"));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  expect(calls).toEqual([
    expect.objectContaining({
      name: "web",
      namespace: "team-a",
      propagation: "foreground",
      resource: DEPLOYMENTS.resource,
    }),
  ]);
  expect(await screen.findByText("deployments.apps is forbidden")).toBeTruthy();
  expect(
    screen.getByText("Could not delete Deployment team-a/web"),
  ).toBeTruthy();
  // The page stays usable once the menu and the dialog have closed.
  expect(document.body.style.pointerEvents).not.toBe("none");
});

test("a cluster-scoped delete sends no namespace", async () => {
  const calls: { namespace: string | null }[] = [];
  const fake = fakeBackend({
    resourceDelete: (a) => {
      calls.push(a);
      return null;
    },
  });
  await show(fake, [{ metadata: { name: "node-1" } }], NODES);
  openMenu("row-menu-node-1");
  fireEvent.click(screen.getByTestId("menu-item-delete"));
  await screen.findByRole("dialog");
  fireEvent.click(screen.getByTestId("delete-confirm"));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0].namespace).toBeNull();
});

test("delete is disabled when can_delete is false", async () => {
  const fake = fakeBackend();
  await show(fake, [pod("a")], info({}, { canDelete: false }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Select default/a" }));
  const bulk = screen.getByTestId("bulk-delete") as HTMLButtonElement;
  expect(bulk.disabled).toBe(true);
  openMenu("row-menu-a");
  expect(
    screen.getByTestId("menu-item-delete").getAttribute("data-disabled"),
  ).not.toBeNull();
});

const WIDGET_CRD: KubeObject = {
  metadata: { name: "widgets.example.com" },
  spec: {
    versions: [
      {
        name: "v1",
        additionalPrinterColumns: [
          { name: "Size", type: "integer", jsonPath: ".spec.size" },
          { name: "Extra", type: "string", jsonPath: ".x", priority: 1 },
        ],
      },
    ],
  },
};

test("a custom resource uses the printer columns of its definition", async () => {
  const fake = fakeBackend();
  const widget = { metadata: { name: "w", namespace: "a" }, spec: { size: 7 } };
  await show(fake, [widget], WIDGETS, "c1", [WIDGETS, CRDS]);
  await fake.send("customresourcedefinitions", {
    type: "snapshot",
    items: [WIDGET_CRD],
  } as WatchEvent);
  expect(screen.getByRole("columnheader", { name: /Size/ })).toBeTruthy();
  expect(screen.getByText("7")).toBeTruthy();
  expect(screen.getByRole("columnheader", { name: "Name" })).toBeTruthy();
  expect(screen.getByRole("columnheader", { name: /Namespace/ })).toBeTruthy();
  // Priority above zero starts hidden and can be turned on.
  expect(screen.queryByRole("columnheader", { name: /Extra/ })).toBeNull();
  openMenu("columns-menu");
  fireEvent.click(screen.getByTestId("column-option-printer-Extra"));
  closeMenu();
  expect(screen.getByRole("columnheader", { name: /Extra/ })).toBeTruthy();
});

test("a custom resource falls back to the defaults when definitions are forbidden", async () => {
  const fake = fakeBackend();
  const widget = { metadata: { name: "w", namespace: "a" }, spec: { size: 7 } };
  await show(fake, [widget], WIDGETS, "c1", [WIDGETS, CRDS]);
  await fake.send("customresourcedefinitions", {
    type: "status",
    status: "forbidden",
    message: "customresourcedefinitions is forbidden",
  });
  expect(screen.getByTestId("resource-table")).toBeTruthy();
  expect(screen.getByRole("columnheader", { name: /Age/ })).toBeTruthy();
});

test("definitions are not watched when the user may not list them or the kind is built in", async () => {
  const watched: string[] = [];
  const fake = fakeBackend({ subscribe: (r) => watched.push(r.plural) });
  const hidden = { ...CRDS, canList: false };
  const first = await show(fake, [], WIDGETS, "c1", [WIDGETS, hidden]);
  expect(watched).toEqual(["widgets"]);
  first.unmount();
  resetResourcesForTest();
  watched.length = 0;
  await show(fake, [pod("a")], PODS, "c1", [PODS, CRDS]);
  expect(watched).toEqual(["pods"]);
});

test("a registered kind supplies its columns and row actions", async () => {
  const run = vi.fn();
  registerKind("kinds.test", "gadgets", {
    columns: () => [
      {
        id: "gadget",
        header: "Gadget",
        width: 80,
        render: (o) => `gadget ${o.metadata.name}`,
      },
    ],
    actions: [
      { id: "poke", label: "Poke", icon: Circle, run },
      {
        id: "never",
        label: "Never",
        icon: Circle,
        visible: () => false,
        run,
      },
      {
        id: "fail",
        label: "Explode",
        icon: Circle,
        run: () => Promise.reject(new Error("the gadget exploded")),
      },
    ],
  });
  const gadgets = info({
    group: "kinds.test",
    plural: "gadgets",
    kind: "Gadget",
  });
  const fake = fakeBackend();
  await show(fake, [pod("g")], gadgets);
  expect(screen.getByText("gadget g")).toBeTruthy();
  expect(screen.queryByRole("columnheader", { name: /Age/ })).toBeNull();

  openMenu("row-menu-g");
  expect(screen.queryByTestId("menu-item-never")).toBeNull();
  fireEvent.click(screen.getByTestId("menu-item-poke"));
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0][0].clusterId).toBe("c1");
  expect(run.mock.calls[0][1].metadata.name).toBe("g");

  // An action that fails says so.
  openMenu("row-menu-g");
  fireEvent.click(screen.getByTestId("menu-item-fail"));
  expect(await screen.findByText("the gadget exploded")).toBeTruthy();
});

test("an action can ask for confirmation", async () => {
  const answers: boolean[] = [];
  registerKind("kinds.test", "doodads", {
    actions: [
      {
        id: "ask",
        label: "Ask",
        icon: Circle,
        run: async (ctx) => {
          answers.push(
            await ctx.confirm({
              title: "Sure?",
              body: "This does a thing.",
              confirmLabel: "Do it",
            }),
          );
        },
      },
    ],
  });
  const doodads = info({
    group: "kinds.test",
    plural: "doodads",
    kind: "Doodad",
  });
  const fake = fakeBackend();
  await show(fake, [pod("d")], doodads);
  openMenu("row-menu-d");
  fireEvent.click(screen.getByTestId("menu-item-ask"));
  fireEvent.click(await screen.findByRole("button", { name: "Do it" }));
  await waitFor(() => expect(answers).toEqual([true]));
});

function route(context: object, path = "/r/core/pods") {
  return (
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<Outlet context={context} />}>
          <Route path="r/:group/:plural" element={<ResourceRoute />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

test("the route explains a resource the cluster does not serve", async () => {
  mockBackend({});
  render(
    route({
      clusterId: "c1",
      resources: [],
      resourcesLoading: false,
      resourcesError: null,
    }),
  );
  expect(screen.getByTestId("resource-status").textContent).toContain(
    "does not serve",
  );
});

test("the route says when discovery failed and shows loading until it answers", async () => {
  mockBackend({});
  const { rerender } = render(
    route({
      clusterId: "c1",
      resources: [],
      resourcesLoading: true,
      resourcesError: null,
    }),
  );
  expect(screen.getByRole("status", { name: /Loading/ })).toBeTruthy();
  rerender(
    route({
      clusterId: "c1",
      resources: [],
      resourcesLoading: false,
      resourcesError: "discovery broke",
    }),
  );
  const status = screen.getByTestId("resource-status");
  expect(status.textContent).toContain("discovery broke");
  expect(status.textContent).not.toContain("does not serve");
});

test("the route shows the table for a served resource", async () => {
  const fake = fakeBackend();
  render(
    route({
      clusterId: "c1",
      resources: [PODS],
      resourcesLoading: false,
      resourcesError: null,
    }),
  );
  await act(flush);
  await fake.send("pods", {
    type: "snapshot",
    items: [pod("a")],
  } as WatchEvent);
  expect(row("default", "a")).toBeTruthy();
});

test("clicking a row opens its detail drawer through the object param, and Escape closes it", async () => {
  const fake = fakeBackend();
  await show(fake, [pod("web", "team-a")]);
  expect(screen.queryByTestId("detail-drawer")).toBeNull();
  fireEvent.click(row("team-a", "web") as HTMLElement);
  expect(screen.getByTestId("detail-title").textContent).toBe("web");
  expect(row("team-a", "web")?.getAttribute("aria-current")).toBe("true");
  fireEvent.keyDown(screen.getByTestId("detail-close"), { key: "Escape" });
  expect(screen.queryByTestId("detail-drawer")).toBeNull();
});

test("Edit YAML in a row's menu opens the object in the dock", async () => {
  const fake = fakeBackend();
  await show(fake, [pod("web", "team-a")]);

  openMenu("row-menu-web");
  fireEvent.click(screen.getByTestId("menu-item-edit"));

  const { tabs, activeId } = useDock.getState();
  expect(tabs).toHaveLength(1);
  expect(tabs[0]).toMatchObject({
    kind: "edit",
    clusterId: "c1",
    title: "Pod team-a/web",
    resource: PODS.resource,
    namespace: "team-a",
    name: "web",
  });
  expect(activeId).toBe(tabs[0].id);
  resetDockForTest();
});

test("a row's menu lists Edit YAML, the kind's actions, then Delete, each with an icon", async () => {
  registerKind("kinds.test", "sprockets", {
    actions: [{ id: "spin", label: "Spin", icon: Circle, run: () => {} }],
  });
  const sprockets = info({
    group: "kinds.test",
    plural: "sprockets",
    kind: "Sprocket",
  });
  await show(fakeBackend(), [pod("s")], sprockets);
  openMenu("row-menu-s");
  const entries = screen.getAllByRole("menuitem");
  expect(entries.map((e) => e.getAttribute("data-testid"))).toEqual([
    "menu-item-edit",
    "menu-item-spin",
    "menu-item-delete",
  ]);
  for (const entry of entries)
    expect(entry.querySelector("svg")).not.toBeNull();
});

test("the drawer header opens Edit YAML, and its More actions offer Delete", async () => {
  const fake = fakeBackend();
  await show(fake, [pod("web", "team-a")], DEPLOYMENTS);
  fireEvent.click(row("team-a", "web") as HTMLElement);

  fireEvent.click(screen.getByTestId("detail-action-edit"));
  expect(useDock.getState().tabs[0]).toMatchObject({
    kind: "edit",
    namespace: "team-a",
    name: "web",
  });
  resetDockForTest();

  openMenu("detail-more-actions");
  expect(
    screen.getAllByRole("menuitem").map((m) => m.getAttribute("data-testid")),
  ).toEqual(["menu-item-edit", "menu-item-delete"]);
  fireEvent.click(screen.getByTestId("menu-item-delete"));
  expect(await screen.findByRole("dialog")).toBeTruthy();
});

const GADGET = { group: "example.com", plural: "gadgets", kind: "Gadget" };

test.each([
  [false, true],
  [true, false],
])(
  "an action that needs patch, with canPatch %s, is disabled: %s",
  async (canPatch, disabled) => {
    registerKind("example.com", "gadgets", {
      actions: [
        {
          id: "go",
          label: "Go",
          icon: Circle,
          requires: "patch",
          run: () => {},
        },
      ],
    });
    await show(fakeBackend(), [pod("a")], info(GADGET, { canPatch }));
    openMenu("row-menu-a");
    const item = screen.getByTestId("menu-item-go");
    expect(item.getAttribute("data-disabled") !== null).toBe(disabled);
  },
);

test("a cluster-scoped row's checkbox names the object, not a path", async () => {
  await show(fakeBackend(), [{ metadata: { name: "node-1" } }], NODES);
  expect(screen.getByRole("checkbox", { name: "Select node-1" })).toBeTruthy();
});
const opened: string[][] = [];

function OwnDelete(props: DeleteDialogProps) {
  opened.push(props.objects.map((o) => o.metadata.name));
  return (
    <div data-testid="own-delete">
      <button type="button" onClick={props.onCancel}>
        Close own
      </button>
    </div>
  );
}

test("a kind's own delete dialog serves the row menu, the drawer and bulk delete", async () => {
  opened.length = 0;
  registerKind("kinds.test", "deletables", { deleteDialog: OwnDelete });
  const deletables = info({
    group: "kinds.test",
    plural: "deletables",
    kind: "Deletable",
  });
  const fake = fakeBackend();
  await show(fake, [pod("a"), pod("b")], deletables);

  openMenu("row-menu-a");
  fireEvent.click(screen.getByTestId("menu-item-delete"));
  expect(screen.getByTestId("own-delete")).toBeTruthy();
  expect(screen.queryByTestId("delete-confirm")).toBeNull();
  expect(opened.at(-1)).toEqual(["a"]);
  fireEvent.click(screen.getByText("Close own"));
  expect(screen.queryByTestId("own-delete")).toBeNull();

  fireEvent.click(row("default", "a") as HTMLElement);
  openMenu("detail-more-actions");
  fireEvent.click(screen.getByTestId("menu-item-delete"));
  expect(screen.getByTestId("own-delete")).toBeTruthy();
  expect(opened.at(-1)).toEqual(["a"]);
  fireEvent.click(screen.getByText("Close own"));

  for (const name of ["a", "b"]) {
    fireEvent.click(
      screen.getByRole("checkbox", { name: `Select default/${name}` }),
    );
  }
  fireEvent.click(screen.getByTestId("bulk-delete"));
  expect(screen.getByTestId("own-delete")).toBeTruthy();
  expect(opened.at(-1)).toEqual(["a", "b"]);
});

test("a row click while a linked object is shown clears the history", async () => {
  const fake = fakeBackend();
  const NAMESPACES = info({
    plural: "namespaces",
    kind: "Namespace",
    namespaced: false,
  });
  await show(
    fake,
    [pod("web", "team-a"), pod("db", "team-a")],
    DEPLOYMENTS,
    "c1",
    [DEPLOYMENTS, NAMESPACES],
  );
  fireEvent.click(row("team-a", "web") as HTMLElement);
  await act(flush);
  const namespaceLink = () =>
    within(screen.getByTestId("detail-relations")).getByRole("button", {
      name: "team-a",
    });
  fireEvent.click(namespaceLink());
  await act(flush);
  await fake.send("namespaces", {
    type: "snapshot",
    items: [{ metadata: { name: "team-a" } }],
  } as WatchEvent);
  expect(screen.getByTestId("detail-kind").textContent).toBe("Namespace");
  expect(screen.getByTestId("detail-back").getAttribute("aria-label")).toBe(
    "Back to web",
  );
  // No row is active while the drawer shows another kind.
  expect(row("team-a", "web")?.getAttribute("aria-current")).toBeNull();

  fireEvent.click(row("team-a", "db") as HTMLElement);
  await act(flush);
  expect(screen.getByTestId("detail-title").textContent).toBe("db");
  expect(screen.queryByTestId("detail-back")).toBeNull();
  expect(row("team-a", "db")?.getAttribute("aria-current")).toBe("true");

  // The root's own row shows the root again.
  fireEvent.click(namespaceLink());
  await act(flush);
  fireEvent.click(row("team-a", "db") as HTMLElement);
  await act(flush);
  expect(screen.getByTestId("detail-kind").textContent).toBe("Deployment");
  expect(screen.getByTestId("detail-title").textContent).toBe("db");
  expect(screen.queryByTestId("detail-back")).toBeNull();
});
