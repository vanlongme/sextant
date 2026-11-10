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
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { ClusterEntry } from "../../ipc/generated/ClusterEntry";
import type { ClusterInfo } from "../../ipc/generated/ClusterInfo";
import type { ObjectNames } from "../../ipc/generated/ObjectNames";
import { resetCatalogForTest, useCatalog } from "../../stores/catalog";
import { resetShellForTest, useShell } from "../../stores/shell";
import { clusterEntry, emitEvent, mockBackend } from "../../test/ipc";
import { CommandPalette } from "./CommandPalette";

const INFO: ClusterInfo = {
  version: "v1.31.0",
  distribution: "kind",
  nodeCount: 1,
  namespaces: ["default", "kube-system"],
  namespacesRestricted: false,
  isAdmin: true,
};
const PROD = clusterEntry({
  id: "c1",
  contextName: "prod",
  state: { status: "connected", info: INFO },
});
const STAGING = clusterEntry({ id: "c2", contextName: "staging" });

function info(plural: string, kind: string): ApiResourceInfo {
  return {
    resource: { group: "", version: "v1", plural, kind, namespaced: true },
    verbs: ["list", "watch"],
    shortNames: [],
    canList: true,
    canWatch: true,
    canCreate: true,
    canUpdate: true,
    canPatch: true,
    canDelete: true,
  };
}
const RESOURCES = [
  info("pods", "Pod"),
  info("configmaps", "ConfigMap"),
  info("nodes", "Node"),
];

const NAMES: ObjectNames = {
  items: [
    {
      kind: "Pod",
      group: "",
      plural: "pods",
      namespace: "default",
      name: "web-1",
    },
    {
      kind: "ConfigMap",
      group: "",
      plural: "configmaps",
      namespace: "default",
      name: "kube-root-ca.crt",
    },
    {
      kind: "ConfigMap",
      group: "",
      plural: "configmaps",
      namespace: "kube-system",
      name: "kube-root-ca.crt",
    },
    {
      kind: "Node",
      group: "",
      plural: "nodes",
      namespace: null,
      name: "node-a",
    },
  ],
  truncated: [],
};

const CONNECTED = { status: "connected", info: INFO } as const;

function Where() {
  const location = useLocation();
  return (
    <output data-testid="where">{`${location.pathname}${location.search}`}</output>
  );
}

/** Renders the palette on `path` and opens it with the focus on a button. */
async function show(
  path: string,
  over: Record<string, (args: never) => unknown> = {},
  clusters: ClusterEntry[] = [PROD, STAGING],
) {
  const ipc = mockBackend({
    catalog_list: () => clusters,
    catalog_warnings: () => [],
    hotbar_get: () => [],
    resources_discover: () => RESOURCES,
    resources_names: () => NAMES,
    ...over,
  });
  await useCatalog.getState().init();
  render(
    <MemoryRouter initialEntries={[path]}>
      <button type="button" data-testid="opener">
        opener
      </button>
      <CommandPalette />
      <Where />
    </MemoryRouter>,
  );
  screen.getByTestId("opener").focus();
  await openPalette();
  return ipc;
}

async function openPalette(): Promise<void> {
  act(() => useShell.getState().open("palette"));
  await screen.findByTestId("palette-input");
}

function type(text: string): void {
  fireEvent.change(screen.getByTestId("palette-input"), {
    target: { value: text },
  });
}

function press(key: string): void {
  fireEvent.keyDown(screen.getByTestId("palette-input"), { key });
}

function sectionIds(): string[] {
  return screen
    .queryAllByTestId(/^palette-section-/)
    .map((s) => s.getAttribute("data-testid") ?? "");
}

function rowIds(section: string): string[] {
  return within(screen.getByTestId(`palette-section-${section}`))
    .queryAllByRole("option")
    .map((o) => o.getAttribute("data-testid") ?? "");
}

function selectedId(): string | null {
  return (
    screen
      .getByTestId("palette")
      .querySelector('[aria-selected="true"]')
      ?.getAttribute("data-testid") ?? null
  );
}

function where(): string {
  return screen.getByTestId("where").textContent ?? "";
}

beforeEach(() => {
  resetCatalogForTest();
  resetShellForTest();
});

test("without a query: Commands and Clusters at their caps", async () => {
  const nine = Array.from({ length: 9 }, (_, i) =>
    clusterEntry({ id: `k${i}`, contextName: `cluster-${i}` }),
  );
  await show("/catalog", {}, nine);

  expect(
    screen
      .getByRole("dialog", { name: "Command palette" })
      .hasAttribute("data-shell-dialog"),
  ).toBe(true);
  expect(sectionIds()).toEqual([
    "palette-section-commands",
    "palette-section-clusters",
  ]);
  expect(rowIds("commands")).toEqual([
    "palette-command-catalog",
    "palette-command-preferences",
    "palette-command-add-cluster",
    "palette-command-shortcuts",
    "palette-command-about",
    "palette-command-theme-dark",
  ]);
  expect(rowIds("clusters")).toHaveLength(8);
  expect(screen.getByTestId("palette-count").textContent).toBe("14 results");
});

test("with a query the caps change, and Pages and Objects join on a connected cluster", async () => {
  const nine = Array.from({ length: 9 }, (_, i) =>
    clusterEntry({ id: `k${i}`, contextName: `cluster-${i}` }),
  );
  await show("/cluster/c1", {}, [PROD, ...nine]);

  type("e");

  await screen.findByTestId("palette-section-objects");
  expect(rowIds("commands")).toHaveLength(8);
  expect(rowIds("clusters")).toHaveLength(6);
  expect(screen.getByTestId("palette-section-pages").textContent).toContain(
    "Pages in prod",
  );
  expect(screen.getByTestId("palette-section-objects").textContent).toContain(
    "Objects in prod",
  );
});

test("Pages and Objects stay hidden off a connected cluster", async () => {
  const ipc = await show("/cluster/c2");

  type("pods");

  expect(sectionIds()).not.toContain("palette-section-pages");
  expect(sectionIds()).not.toContain("palette-section-objects");
  expect(screen.queryByTestId("palette-objects-status")).toBeNull();
  expect(ipc.callsTo("resources_names")).toHaveLength(0);
});

test("sections sort by their best row", async () => {
  await show("/cluster/c1");

  type("web");

  await screen.findByTestId("palette-object-pods-default-web-1");
  expect(sectionIds()).toEqual([
    "palette-section-objects",
    "palette-section-commands",
  ]);
});

test("Up and Down wrap, and hovering a row selects it", async () => {
  await show("/catalog");

  expect(selectedId()).toBe("palette-command-catalog");
  press("ArrowUp");
  expect(selectedId()).toBe("palette-cluster-c2");
  press("ArrowDown");
  expect(selectedId()).toBe("palette-command-catalog");
  press("ArrowDown");
  expect(selectedId()).toBe("palette-command-preferences");
  fireEvent.mouseMove(screen.getByTestId("palette-command-about"));
  expect(selectedId()).toBe("palette-command-about");
});

test("the first row is selected whenever the query changes", async () => {
  await show("/catalog");

  press("ArrowDown");
  press("ArrowDown");
  type("theme");

  expect(selectedId()).toBe("palette-command-theme-dark");
});

test("Enter closes the palette, then runs the row: About replaces it", async () => {
  await show("/catalog");

  type("about");
  press("Enter");

  await waitFor(() => expect(screen.queryByTestId("palette")).toBeNull());
  expect(useShell.getState().dialog).toBe("about");
});

test("Enter on a cluster opens it", async () => {
  await show("/catalog");

  type("staging");
  press("Enter");

  await waitFor(() => expect(where()).toBe("/cluster/c2"));
  expect(useShell.getState().dialog).toBeNull();
});

test("Esc closes the palette and gives the focus back", async () => {
  await show("/catalog");
  expect(document.activeElement).toBe(screen.getByTestId("palette-input"));

  press("Escape");

  await waitFor(() => expect(screen.queryByTestId("palette")).toBeNull());
  expect(useShell.getState().dialog).toBeNull();
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByTestId("opener")),
  );
});

test("no match says so, and the count reads 0 results or 1 result", async () => {
  await show("/catalog");

  type("zzzz");
  expect(screen.getByTestId("palette-empty").textContent).toBe(
    'Nothing matches "zzzz". Try a cluster, a kind such as Pods, an object name or a command.',
  );
  expect(screen.getByTestId("palette-count").textContent).toBe("0 results");

  type("about");
  expect(screen.queryByTestId("palette-empty")).toBeNull();
  expect(screen.getByTestId("palette-count").textContent).toBe("1 result");
});

test("Objects show a loading row, then the names", async () => {
  let answer: (names: ObjectNames) => void = () => {};
  await show("/cluster/c1", {
    resources_names: () =>
      new Promise<ObjectNames>((resolve) => {
        answer = resolve;
      }),
  });

  type("web");
  expect(screen.getByTestId("palette-objects-status").textContent).toBe(
    "Loading objects…",
  );
  expect(screen.getByTestId("palette-section-commands")).toBeTruthy();

  await act(async () => answer(NAMES));
  expect(
    await screen.findByTestId("palette-object-pods-default-web-1"),
  ).toBeTruthy();
  expect(screen.queryByTestId("palette-objects-status")).toBeNull();
});

test("a failure shows on the Objects row", async () => {
  await show("/cluster/c1", {
    resources_names: () => {
      throw { code: "Internal", message: "server said no", details: null };
    },
  });

  type("web");

  const status = await screen.findByText(
    "Could not load objects: server said no",
  );
  expect(status.getAttribute("data-testid")).toBe("palette-objects-status");
  expect(status.getAttribute("aria-disabled")).toBe("true");
});

test("the footer says when a kind was cut at 2,000, while Objects show", async () => {
  await show("/cluster/c1", {
    resources_names: () => ({ ...NAMES, truncated: ["configmaps"] }),
  });

  type("web");
  expect((await screen.findByTestId("palette-truncated")).textContent).toBe(
    "Objects: first 2,000 of each kind",
  );
  type("");
  expect(screen.queryByTestId("palette-truncated")).toBeNull();
});

test("object rows open the kind's list with the object's drawer", async () => {
  await show("/cluster/c1");

  type("node-a");
  fireEvent.click(await screen.findByTestId("palette-object-nodes-node-a"));
  await waitFor(() =>
    expect(where()).toBe("/cluster/c1/r/core/nodes?object=%2Fnode-a"),
  );

  await openPalette();
  type("web-1");
  fireEvent.click(
    await screen.findByTestId("palette-object-pods-default-web-1"),
  );
  await waitFor(() =>
    expect(where()).toBe("/cluster/c1/r/core/pods?object=default%2Fweb-1"),
  );
});

test("the same name in two namespaces gives two rows that each open their own object", async () => {
  await show("/cluster/c1");

  type("kube-root");

  const first = await screen.findByTestId(
    "palette-object-configmaps-default-kube-root-ca.crt",
  );
  const second = screen.getByTestId(
    "palette-object-configmaps-kube-system-kube-root-ca.crt",
  );
  expect([first.textContent, second.textContent]).toEqual([
    "kube-root-ca.crtConfigMap · default",
    "kube-root-ca.crtConfigMap · kube-system",
  ]);
  expect(selectedId()).toBe(
    "palette-object-configmaps-default-kube-root-ca.crt",
  );
  press("ArrowDown");
  expect(selectedId()).toBe(
    "palette-object-configmaps-kube-system-kube-root-ca.crt",
  );
  press("Enter");
  await waitFor(() =>
    expect(where()).toBe(
      "/cluster/c1/r/core/configmaps?object=kube-system%2Fkube-root-ca.crt",
    ),
  );
});

test("a cluster that connects while the palette is open gets its pages and objects", async () => {
  const connecting = clusterEntry({
    id: "c1",
    contextName: "prod",
    state: { status: "connecting" },
  });
  const ipc = await show("/cluster/c1", {}, [connecting]);

  type("pods");
  expect(sectionIds()).not.toContain("palette-section-pages");
  expect(ipc.callsTo("resources_names")).toHaveLength(0);

  await emitEvent("cluster://state", { id: "c1", state: CONNECTED });

  expect(await screen.findByTestId("palette-page-r/core/pods")).toBeTruthy();
  await waitFor(() =>
    expect(ipc.callsTo("resources_names")).toEqual([{ clusterId: "c1" }]),
  );
});

test("an answer for a connection that has gone is dropped", async () => {
  const answers: ((names: ObjectNames) => void)[] = [];
  const ipc = await show("/cluster/c1", {
    resources_names: () =>
      new Promise<ObjectNames>((resolve) => {
        answers.push(resolve);
      }),
  });
  type("web");
  expect(screen.getByTestId("palette-objects-status").textContent).toBe(
    "Loading objects…",
  );

  await emitEvent("cluster://state", {
    id: "c1",
    state: { status: "disconnected" },
  });
  expect(screen.queryByTestId("palette-objects-status")).toBeNull();
  await emitEvent("cluster://state", { id: "c1", state: CONNECTED });
  await waitFor(() => expect(ipc.callsTo("resources_names")).toHaveLength(2));

  // The first connection's answer arrives late: it must not show.
  await act(async () => answers[0](NAMES));
  expect(screen.queryByTestId("palette-object-pods-default-web-1")).toBeNull();
  expect(screen.getByTestId("palette-objects-status").textContent).toBe(
    "Loading objects…",
  );

  await act(async () => answers[1](NAMES));
  expect(
    await screen.findByTestId("palette-object-pods-default-web-1"),
  ).toBeTruthy();
});

test("labels show their matched letters; a cluster matched by its state has none", async () => {
  await show("/catalog");

  type("stag");
  const marks = screen
    .getByTestId("palette-cluster-c2")
    .querySelectorAll("mark");
  expect([...marks].map((m) => m.textContent)).toEqual(["stag"]);

  type("disconnected");
  expect(rowIds("clusters")).toEqual(["palette-cluster-c2"]);
  expect(
    screen.getByTestId("palette-cluster-c2").querySelector("mark"),
  ).toBeNull();
});
