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

const chip = (ns: string) => screen.getByTestId(`map-ns-${ns}`);

const radio = (value: string) =>
  screen
    .getByTestId(`map-layout-${value}`)
    .querySelector("input") as HTMLInputElement;

const pods = (n: number) =>
  Array.from({ length: n }, (_, i) => gnode(`Pod/big/p-${i}`));

beforeEach(() => {
  mockElementSize(1000, 600);
  resetGraphForTest();
  resetMovedForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ClusterMapScreen", () => {
  it("reads resources, then draws the whole cluster with a chip per namespace", async () => {
    await show();
    expect(screen.getByTestId("map-loading").textContent).toBe(
      "Reading resources…",
    );
    expect(subscribed()).toEqual([null]);
    await g.send(demoSnapshot());
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Resource map",
    );
    expect(screen.getByTestId("map-canvas")).toBeTruthy();
    expect(screen.getByTestId("map-summary").textContent).toBe(
      "22 resources, 3 namespaces",
    );
    expect(
      ["edge", "jobs", "shop"].map((ns) => [
        chip(ns).textContent,
        chip(ns).getAttribute("aria-pressed"),
      ]),
    ).toEqual([
      ["edge 1", "true"],
      ["jobs 4", "true"],
      ["shop 14", "true"],
    ]);
    const search = screen.getByTestId("map-search");
    expect(search.getAttribute("placeholder")).toBe("Find a resource");
    expect(search.getAttribute("aria-label")).toBe(
      "Find a resource by name or kind",
    );
    expect(radio("grouped").checked).toBe(true);
    expect(screen.getByTestId("map-reset").textContent).toBe("Reset layout");
  });

  it("hides a namespace from its chip, saves it and subscribes with the rest", async () => {
    await show();
    await g.send(demoSnapshot());
    fireEvent.click(chip("shop"));
    await act(flush);
    expect(chip("shop").getAttribute("aria-pressed")).toBe("false");
    expect(subscribed()).toEqual([null, ["edge", "jobs"]]);
    expect(g.open()).toEqual(["g2"]);
    await waitFor(() => expect(store["map.hidden.c1"]).toEqual(["shop"]));
  });

  it("subscribes with the shown namespaces of a saved choice once it knows them", async () => {
    await show({ "map.hidden.c1": ["jobs", "shop"] });
    expect(subscribed()).toEqual([[]]);
    await g.send(demoSnapshot());
    expect(subscribed()).toEqual([[], ["edge"]]);
    expect(chip("shop").getAttribute("aria-pressed")).toBe("false");
    expect(chip("edge").getAttribute("aria-pressed")).toBe("true");
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

  it("draws nothing above 1,500 nodes and says so", async () => {
    await show();
    await g.send(snapshotOf(pods(1501), []));
    expect(screen.queryByTestId("map-canvas")).toBeNull();
    const note = screen.getByTestId("map-note");
    expect(note.getAttribute("role")).toBe("note");
    expect(note.textContent).toBe(
      "1,501 resources in the selected namespaces. Hide some namespaces to draw the map.",
    );
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
