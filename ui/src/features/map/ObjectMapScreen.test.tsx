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
  graphBackend,
  servedResource,
} from "../../test/graph";
import { flush } from "../../test/ipc";
import { mockElementSize } from "../../test/size";
import { resetMovedForTest } from "./MapCanvas";
import { MapRoute } from "./MapRoute";
import { trailOf } from "./ObjectMapScreen";
import { objectMapPath } from "./paths";

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

let g: GraphBackend;
let store: Record<string, unknown>;

async function show(path: string, saved: Record<string, unknown> = {}) {
  store = { ...saved };
  g = graphBackend({
    ui_state_get: (a: { key: string }) => store[a.key] ?? null,
    ui_state_set: (a: { key: string; value: unknown }) => {
      store[a.key] = a.value;
      return null;
    },
  });
  const context = {
    clusterId: "c1",
    resources: [servedResource("Deployment", "apps", "deployments")],
    resourcesLoading: false,
    resourcesError: null,
  };
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<Outlet context={context} />}>
          <Route path="cluster/:id/map" element={<MapRoute />} />
        </Route>
      </Routes>
      <Where />
    </MemoryRouter>,
  );
  await act(flush);
}

const subscribed = () =>
  g.backend.callsTo("resource_graph_subscribe").map((a) => a.namespaces);

const radio = (testId: string) =>
  screen.getByTestId(testId).querySelector("input") as HTMLInputElement;

const where = () => screen.getByTestId("where").textContent;

const summary = () => screen.getByTestId("map-summary").textContent;

beforeEach(() => {
  mockElementSize(1000, 600);
  resetGraphForTest();
  resetMovedForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ObjectMapScreen", () => {
  it("subscribes with the focus's namespace and draws its neighbourhood with the focus selected", async () => {
    await show(objectMapPath("c1", DEMO.deployment));
    expect(subscribed()).toEqual([["shop"]]);
    expect(screen.getByTestId("map-loading")).toBeTruthy();
    await g.send(demoSnapshot());
    const page = screen.getByTestId("map-page");
    expect(page.getAttribute("data-focus")).toBe(DEMO.deployment);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("web");
    expect(page.querySelector("header")?.textContent).toContain("Deployment");
    expect(radio("map-depth-2").checked).toBe(true);
    expect(
      ["map-depth-1", "map-depth-2", "map-depth-all"].map(
        (id) => screen.getByTestId(id).textContent,
      ),
    ).toEqual(["1 hop", "2 hops", "All"]);
    expect(radio("map-layout-grouped").checked).toBe(true);
    expect(screen.queryByTestId("map-layout-force")).toBeNull();
    expect(summary()).toBe("15 resources");
    expect(screen.getByTestId("map-reset").textContent).toBe("Reset layout");
    expect(screen.queryByTestId("map-search")).toBeNull();
    expect(screen.queryByTestId("map-ns-shop")).toBeNull();
    expect(screen.queryByTestId("map-back")).toBeNull();
    const focus = document.querySelector(
      `[data-testid="map-node"][data-id="${DEMO.deployment}"]`,
    );
    expect(focus?.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("map-details").textContent).toContain(
      "Deployment in shop",
    );
    expect(screen.queryByTestId("map-details-focus")).toBeNull();
    // The StatefulSet in the same namespace is not part of the neighbourhood.
    expect(
      document.querySelector(`[data-id="${DEMO.statefulSet}"]`),
    ).toBeNull();
  });

  it("subscribes with every namespace for a load balancer", async () => {
    await show(objectMapPath("c1", DEMO.gatewayLb));
    expect(subscribed()).toEqual([null]);
    await g.send(demoSnapshot());
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "203.0.113.24",
    );
    expect(
      document.querySelector(
        `[data-testid="map-node"][data-id="${DEMO.route}"]`,
      ),
    ).toBeTruthy();
  });

  it("writes the depth to the query, and 1 hop draws less", async () => {
    await show(objectMapPath("c1", DEMO.deployment));
    await g.send(demoSnapshot());
    fireEvent.click(screen.getByTestId("map-depth-1"));
    expect(where()).toBe(
      "/cluster/c1/map?focus=Deployment%2Fshop%2Fweb&depth=1",
    );
    expect(radio("map-depth-1").checked).toBe(true);
    expect(summary()).toBe("9 resources");
    fireEvent.click(screen.getByTestId("map-depth-all"));
    expect(where()).toBe(
      "/cluster/c1/map?focus=Deployment%2Fshop%2Fweb&depth=all",
    );
    fireEvent.click(screen.getByTestId("map-depth-2"));
    expect(where()).toBe("/cluster/c1/map?focus=Deployment%2Fshop%2Fweb");
    expect(summary()).toBe("15 resources");
    // The depth is one subscription: the graph is cut, not read again.
    expect(subscribed()).toEqual([["shop"]]);
  });

  it("reads the depth from the query", async () => {
    await show(`${objectMapPath("c1", DEMO.deployment)}&depth=1`);
    await g.send(demoSnapshot());
    expect(radio("map-depth-1").checked).toBe(true);
    expect(summary()).toBe("9 resources");
  });

  it("keeps the layout under map.objectLayout", async () => {
    await show(objectMapPath("c1", DEMO.deployment), {
      "map.objectLayout": "layered",
    });
    await g.send(demoSnapshot());
    expect(radio("map-layout-layered").checked).toBe(true);
    fireEvent.click(screen.getByTestId("map-layout-grouped"));
    expect(radio("map-layout-grouped").checked).toBe(true);
    await waitFor(() => expect(store["map.objectLayout"]).toBe("grouped"));
  });

  it("moves the focus from the details pane with a trail, and Back returns", async () => {
    await show(objectMapPath("c1", DEMO.deployment));
    await g.send(demoSnapshot());
    const owns = screen
      .getAllByTestId("map-connection")
      .find((row) => row.getAttribute("data-id") === DEMO.replicaSet);
    fireEvent.click(owns as HTMLElement);
    fireEvent.click(screen.getByTestId("map-details-focus"));
    expect(where()).toBe("/cluster/c1/map?focus=ReplicaSet%2Fshop%2Fweb-7d9");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "web-7d9",
    );
    expect(screen.getByTestId("map-details").textContent).toContain(
      "ReplicaSet in shop",
    );
    expect(screen.getByTestId("map-back").textContent).toBe(
      "Back to Deployment web",
    );
    fireEvent.click(screen.getByTestId("map-back"));
    await act(flush);
    expect(where()).toBe("/cluster/c1/map?focus=Deployment%2Fshop%2Fweb");
    expect(screen.queryByTestId("map-back")).toBeNull();
    expect(subscribed()).toEqual([["shop"]]);
  });

  it("says when the focus no longer exists and goes back to the cluster map", async () => {
    await show(objectMapPath("c1", "Deployment/shop/gone"));
    await g.send(demoSnapshot());
    expect(screen.getByTestId("map-empty").textContent).toContain(
      "Deployment gone no longer exists.",
    );
    expect(screen.queryByTestId("map-summary")).toBeNull();
    const back = screen.getByTestId("map-to-cluster");
    expect(back.textContent).toBe("Back to the cluster map");
    fireEvent.click(back);
    expect(where()).toBe("/cluster/c1/map");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Resource map",
    );
  });

  it("shows a failure and subscribes again on Retry", async () => {
    await show(objectMapPath("c1", DEMO.deployment));
    await g.send({ type: "failure", message: "watch ended" });
    expect(screen.getByTestId("map-error").textContent).toContain(
      "The map could not be built: watch ended",
    );
    fireEvent.click(screen.getByTestId("map-retry"));
    await act(flush);
    expect(subscribed()).toEqual([["shop"], ["shop"]]);
  });
});

describe("trailOf", () => {
  it("reads a trail of ids and ignores anything else", () => {
    expect(trailOf({ trail: ["Pod/a/b"] })).toEqual(["Pod/a/b"]);
    expect(trailOf(null)).toEqual([]);
    expect(trailOf({ trail: [1] })).toEqual([]);
    expect(trailOf("x")).toEqual([]);
  });
});
