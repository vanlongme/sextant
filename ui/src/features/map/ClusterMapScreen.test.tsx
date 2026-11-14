import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGraphForTest } from "../../stores/graph";
import {
  DEMO,
  demoSnapshot,
  type GraphBackend,
  gnode,
  graphBackend,
  servedResource,
  snapshotOf,
} from "../../test/graph";
import { flush } from "../../test/ipc";
import { mockElementSize } from "../../test/size";
import { ClusterMapScreen, FORCE_HINT } from "./ClusterMapScreen";
import { resetMovedForTest } from "./MapCanvas";

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

let g: GraphBackend;
let store: Record<string, unknown>;

async function show(
  saved: Record<string, unknown> = {},
  defaultNamespace: string | null = null,
) {
  store = { ...saved };
  g = graphBackend({
    ui_state_get: (a: { key: string }) => store[a.key] ?? null,
    ui_state_set: (a: { key: string; value: unknown }) => {
      store[a.key] = a.value;
      return null;
    },
    cluster_settings_get: () => ({
      icon: null,
      defaultNamespace,
      accessibleNamespaces: [],
      terminalCwd: null,
      proxyUrl: null,
      nodeShellImage: null,
    }),
  });
  const context = {
    clusterId: "c1",
    resources: [servedResource("CronJob", "batch", "cronjobs")],
    resourcesLoading: false,
    resourcesError: null,
  };
  render(
    <MemoryRouter initialEntries={["/cluster/c1/map"]}>
      <Routes>
        <Route element={<Outlet context={context} />}>
          <Route path="cluster/:id/map" element={<ClusterMapScreen />} />
        </Route>
      </Routes>
      <Where />
    </MemoryRouter>,
  );
  await act(flush);
}

const subscribed = () =>
  g.backend.callsTo("resource_graph_subscribe").map((a) => a.namespaces);

const box = (testId: string) => screen.getByTestId(testId) as HTMLInputElement;

const radio = (value: string) =>
  screen
    .getByTestId(`map-layout-${value}`)
    .querySelector("input") as HTMLInputElement;

const pods = (n: number) =>
  Array.from({ length: n }, (_, i) => gnode(`Pod/big/p-${i}`));

const secrets = (n: number) =>
  Array.from({ length: n }, (_, i) => gnode(`Secret/big/s-${i}`));

beforeEach(() => {
  mockElementSize(1000, 600);
  resetGraphForTest();
  resetMovedForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ClusterMapScreen", () => {
  it("reads resources, then draws the whole cluster under its filters row", async () => {
    await show();
    expect(screen.getByTestId("map-loading").textContent).toBe(
      "Reading resources…",
    );
    expect(screen.queryByTestId("map-filters")).toBeNull();
    expect(subscribed()).toEqual([null]);
    await g.send(demoSnapshot());
    const title = screen.getByRole("heading", { level: 1 });
    expect(title.textContent).toBe("Resource map");
    expect(screen.getByTestId("map-canvas")).toBeTruthy();
    const row = screen.getByRole("group", { name: "Map filters" });
    expect(row.getAttribute("data-testid")).toBe("map-filters");
    expect(screen.getByTestId("map-ns-filter").textContent).toBe(
      "All namespaces",
    );
    expect(screen.getByTestId("map-kind-filter").textContent).toBe("All kinds");
    expect(screen.queryByTestId("map-clear-filters")).toBeNull();
    expect(screen.queryByTestId("map-ns-shop")).toBeNull();
    const summary = screen.getByTestId("map-summary");
    expect(row.contains(summary)).toBe(true);
    expect(summary.textContent).toBe("22 resources · 3 namespaces · 16 kinds");
    expect(summary.getAttribute("title")).toBe("Every resource in the cluster");
    const header = title.parentElement as HTMLElement;
    expect(header.contains(summary)).toBe(false);
    expect(header.lastElementChild).toBe(screen.getByTestId("map-reset"));
    const search = screen.getByTestId("map-search");
    expect(search.getAttribute("placeholder")).toBe("Find a resource");
    expect(search.getAttribute("aria-label")).toBe(
      "Find a resource by name or kind",
    );
    expect(radio("grouped").checked).toBe(true);
    expect(screen.getByTestId("map-reset").textContent).toBe("Reset layout");
  });

  it("hides a namespace from the Namespaces dropdown, saves it and subscribes with the rest", async () => {
    await show();
    await g.send(demoSnapshot());
    fireEvent.click(screen.getByTestId("map-ns-filter"));
    fireEvent.click(box("map-ns-option-shop"));
    await act(flush);
    expect(box("map-ns-option-shop").checked).toBe(false);
    expect(screen.getByTestId("map-ns-filter").textContent).toBe(
      "2 namespaces",
    );
    expect(screen.getByTestId("map-clear-filters")).toBeTruthy();
    expect(subscribed()).toEqual([null, ["edge", "jobs"]]);
    expect(g.open()).toEqual(["g2"]);
    await waitFor(() => expect(store["map.hidden.c1"]).toEqual(["shop"]));
  });

  it("subscribes with the shown namespaces of a saved choice once it knows them", async () => {
    await show({ "map.hidden.c1": ["jobs", "shop"] });
    expect(subscribed()).toEqual([[]]);
    await g.send(demoSnapshot());
    expect(subscribed()).toEqual([[], ["edge"]]);
    const trigger = screen.getByTestId("map-ns-filter");
    expect(trigger.textContent).toBe("edge");
    expect(trigger.getAttribute("title")).toBe("Namespaces: edge");
    fireEvent.click(trigger);
    expect(box("map-ns-option-shop").checked).toBe(false);
    expect(box("map-ns-option-edge").checked).toBe(true);
  });

  it("says when every namespace is hidden", async () => {
    await show({ "map.hidden.c1": ["edge", "jobs", "shop"] });
    await g.send(demoSnapshot({ nodes: [], edges: [] }));
    expect(screen.getByTestId("map-empty").textContent).toBe(
      "All namespaces are hidden. Pick one above to draw the map.",
    );
    expect(subscribed()).toEqual([[]]);
  });

  it("hides all but the default namespace on a large cluster with no saved choice", async () => {
    await show({}, "jobs");
    await g.send(
      demoSnapshot({
        counts: [
          { namespace: "edge", nodes: 1 },
          { namespace: "jobs", nodes: 600 },
          { namespace: "shop", nodes: 1000 },
        ],
      }),
    );
    await act(flush);
    expect(subscribed()).toEqual([null, ["jobs"]]);
    await waitFor(() =>
      expect(store["map.hidden.c1"]).toEqual(["edge", "shop"]),
    );
  });

  it("keeps the first namespace by name when the default one has no nodes", async () => {
    await show({}, "default");
    await g.send(
      demoSnapshot({
        counts: [
          { namespace: "edge", nodes: 1 },
          { namespace: "shop", nodes: 1600 },
        ],
      }),
    );
    await act(flush);
    expect(subscribed()).toEqual([null, ["edge"]]);
  });

  it("hides a kind from the Kinds dropdown, saves it and draws its bridges", async () => {
    await show({ "map.layout.c1": "layered" });
    await g.send(demoSnapshot());
    fireEvent.click(screen.getByTestId("map-kind-filter"));
    fireEvent.click(box("map-kind-option-ReplicaSet"));
    expect(screen.getByTestId("map-kind-filter").textContent).toBe(
      "15 of 16 kinds",
    );
    expect(screen.getByTestId("map-clear-filters")).toBeTruthy();
    // The Kinds filter is the client's: the subscription stays.
    expect(subscribed()).toEqual([null]);
    const edges = screen.getAllByTestId("map-edge");
    const bridge = edges.find(
      (el) =>
        el.getAttribute("data-from") === DEMO.deployment &&
        el.getAttribute("data-to") === DEMO.podA,
    );
    expect(bridge?.getAttribute("data-rel")).toBe("owns");
    expect(bridge?.getAttribute("data-via")).toBe("ReplicaSet");
    expect(
      edges.some(
        (el) =>
          el.getAttribute("data-from") === DEMO.replicaSet ||
          el.getAttribute("data-to") === DEMO.replicaSet,
      ),
    ).toBe(false);
    const summary = screen.getByTestId("map-summary");
    expect(summary.textContent).toBe(
      "21 of 22 resources · 3 namespaces · 15 kinds",
    );
    expect(summary.getAttribute("title")).toBe(
      "Drawn now, of every resource in the cluster",
    );
    await waitFor(() =>
      expect(store["map.hiddenKinds.c1"]).toEqual(["ReplicaSet"]),
    );
  });

  it("keeps the Kinds dropdown while a new namespace filter loads", async () => {
    await show({ "map.hiddenKinds.c1": ["ReplicaSet"] });
    await g.send(demoSnapshot());
    expect(screen.getByTestId("map-kind-filter").textContent).toBe(
      "15 of 16 kinds",
    );
    fireEvent.click(screen.getByTestId("map-ns-filter"));
    fireEvent.click(box("map-ns-option-jobs"));
    await act(flush);
    expect(screen.getByTestId("map-loading")).toBeTruthy();
    expect(screen.getByTestId("map-kind-filter").textContent).toBe(
      "15 of 16 kinds",
    );
    expect(screen.queryByTestId("map-summary")).toBeNull();
  });

  it("says when every present kind is hidden, and Clear filters empties both lists", async () => {
    await show({ "map.hiddenKinds.c1": ["Pod", "Widget"] });
    await g.send(snapshotOf(pods(3), []));
    expect(screen.queryByTestId("map-canvas")).toBeNull();
    expect(screen.getByTestId("map-empty").textContent).toBe(
      "All kinds are hidden. Pick one in Kinds to draw the map.",
    );
    expect(screen.getByTestId("map-kind-filter").textContent).toBe("No kinds");
    expect(screen.getByTestId("map-summary").textContent).toBe(
      "0 of 3 resources · 0 namespaces · 0 kinds",
    );
    fireEvent.click(screen.getByTestId("map-clear-filters"));
    expect(screen.getByTestId("map-canvas")).toBeTruthy();
    expect(screen.queryByTestId("map-clear-filters")).toBeNull();
    expect(screen.getByTestId("map-summary").textContent).toBe(
      "3 resources · 1 namespace · 1 kind",
    );
    await waitFor(() => expect(store["map.hiddenKinds.c1"]).toEqual([]));
    await waitFor(() => expect(store["map.hidden.c1"]).toEqual([]));
    expect(subscribed()).toEqual([null]);
  });

  it("a saved kind that is not present does not filter", async () => {
    await show({ "map.hiddenKinds.c1": ["Widget"] });
    await g.send(demoSnapshot());
    expect(screen.getByTestId("map-kind-filter").textContent).toBe("All kinds");
    expect(screen.queryByTestId("map-clear-filters")).toBeNull();
    expect(screen.getByTestId("map-summary").textContent).toBe(
      "22 resources · 3 namespaces · 16 kinds",
    );
  });

  it("offers Force only up to 400 drawn nodes and falls back to Grouped", async () => {
    await show({ "map.layout.c1": "force" });
    await g.send(snapshotOf(pods(400), []));
    expect(radio("force").checked).toBe(true);
    expect(radio("force").disabled).toBe(false);
    await g.send(snapshotOf(pods(401), []));
    expect(radio("force").disabled).toBe(true);
    expect(screen.getByTestId("map-layout-force").getAttribute("title")).toBe(
      FORCE_HINT,
    );
    expect(radio("grouped").checked).toBe(true);
  });

  it("names kinds in the Force hint", () => {
    expect(FORCE_HINT).toBe(
      "Force works up to 400 resources. Hide some namespaces or kinds to use it.",
    );
  });

  it("draws nothing above 1,500 nodes and says so", async () => {
    await show();
    await g.send(snapshotOf(pods(1501), []));
    expect(screen.queryByTestId("map-canvas")).toBeNull();
    const note = screen.getByTestId("map-note");
    expect(note.getAttribute("role")).toBe("note");
    expect(note.textContent).toBe(
      "1,501 resources in the selected namespaces and kinds. Hide some namespaces or kinds to draw the map.",
    );
  });

  it("counts the drawn nodes for both caps, after the Kinds filter", async () => {
    await show({ "map.layout.c1": "force", "map.hiddenKinds.c1": ["Secret"] });
    await g.send(snapshotOf([...pods(1501), ...secrets(10)], []));
    expect(screen.getByTestId("map-note").textContent).toBe(
      "1,501 resources in the selected namespaces and kinds. Hide some namespaces or kinds to draw the map.",
    );
    await g.send(snapshotOf([...pods(400), ...secrets(10)], []));
    expect(screen.getByTestId("map-canvas")).toBeTruthy();
    expect(radio("force").disabled).toBe(false);
    expect(radio("force").checked).toBe(true);
    fireEvent.click(screen.getByTestId("map-kind-filter"));
    fireEvent.click(box("map-kind-option-Secret"));
    expect(radio("force").disabled).toBe(true);
    expect(radio("grouped").checked).toBe(true);
  });

  it("says when there is nothing to draw", async () => {
    await show();
    await g.send(snapshotOf([], []));
    expect(screen.getByTestId("map-empty").textContent).toBe(
      "No resources in the selected namespaces.",
    );
  });

  it("shows a failure and subscribes again on Retry", async () => {
    await show();
    await g.send(demoSnapshot());
    await g.send({ type: "failure", message: "discovery failed" });
    const error = screen.getByTestId("map-error");
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent).toContain(
      "The map could not be built: discovery failed",
    );
    fireEvent.click(screen.getByTestId("map-retry"));
    await act(flush);
    expect(subscribed()).toEqual([null, null]);
    await g.send(demoSnapshot());
    expect(screen.getByTestId("map-canvas")).toBeTruthy();
  });

  it("notes the kinds the user cannot list above the drawn canvas", async () => {
    await show();
    await g.send(demoSnapshot({ missing: ["secrets", "serviceaccounts"] }));
    expect(screen.getByTestId("map-note").textContent).toBe(
      "Not shown: you cannot list Secrets, ServiceAccounts.",
    );
    expect(screen.getByTestId("map-canvas")).toBeTruthy();
  });

  it("notes a search that matches nothing, and Enter selects the first match", async () => {
    await show();
    await g.send(demoSnapshot());
    const search = screen.getByTestId("map-search");
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(screen.getByTestId("map-note").textContent).toBe(
      "No resource matches “zzz”.",
    );
    fireEvent.change(search, { target: { value: "NIGHTLY" } });
    expect(screen.queryByTestId("map-note")).toBeNull();
    fireEvent.keyDown(search, { key: "Enter" });
    expect(screen.getByTestId("map-details").textContent).toContain(
      "CronJob in jobs",
    );
    fireEvent.click(screen.getByTestId("map-details-close"));
    expect(screen.queryByTestId("map-details")).toBeNull();
  });

  it("clears a selection whose kind gets hidden, and searches drawn nodes only", async () => {
    await show();
    await g.send(demoSnapshot());
    const search = screen.getByTestId("map-search");
    fireEvent.change(search, { target: { value: "nightly" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(screen.getByTestId("map-details").textContent).toContain(
      "CronJob in jobs",
    );
    fireEvent.click(screen.getByTestId("map-kind-filter"));
    fireEvent.click(box("map-kind-option-CronJob"));
    await act(flush);
    expect(screen.queryByTestId("map-details")).toBeNull();
    // Shown again, the CronJob is not selected again: the selection was cleared.
    fireEvent.click(box("map-kind-option-CronJob"));
    await act(flush);
    expect(screen.queryByTestId("map-details")).toBeNull();
    fireEvent.click(box("map-kind-option-CronJob"));
    fireEvent.keyDown(search, { key: "Enter" });
    const details = screen.getByTestId("map-details").textContent;
    expect(details).toContain("Job in jobs");
    expect(details).not.toContain("CronJob");
  });

  it("opens the object map from the details pane", async () => {
    await show();
    await g.send(demoSnapshot());
    fireEvent.change(screen.getByTestId("map-search"), {
      target: { value: "nightly" },
    });
    fireEvent.keyDown(screen.getByTestId("map-search"), { key: "Enter" });
    fireEvent.click(screen.getByTestId("map-details-focus"));
    expect(screen.getByTestId("where").textContent).toBe(
      "/cluster/c1/map?focus=CronJob%2Fjobs%2Fnightly",
    );
  });

  it("saves the layout per cluster", async () => {
    await show();
    await g.send(demoSnapshot());
    fireEvent.click(screen.getByTestId("map-layout-layered"));
    expect(radio("layered").checked).toBe(true);
    await waitFor(() => expect(store["map.layout.c1"]).toBe("layered"));
  });
});
