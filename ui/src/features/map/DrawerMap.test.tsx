import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGraphForTest } from "../../stores/graph";
import {
  DEMO,
  demoSnapshot,
  type GraphBackend,
  graphBackend,
} from "../../test/graph";
import { flush } from "../../test/ipc";
import { mockElementSize } from "../../test/size";
import { DrawerMap, hasDrawerMap } from "./DrawerMap";
import { resetMovedForTest } from "./MapCanvas";

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

let g: GraphBackend;

async function show(kind: string, namespace: string, name: string) {
  g = graphBackend();
  render(
    <MemoryRouter initialEntries={["/cluster/c1/deployments"]}>
      <DrawerMap clusterId="c1" kind={kind} namespace={namespace} name={name} />
      <Where />
    </MemoryRouter>,
  );
  await act(flush);
}

const node = (id: string) =>
  document.querySelector(
    `[data-testid="map-node"][data-id="${id}"]`,
  ) as Element;

beforeEach(() => {
  mockElementSize(360, 600);
  resetGraphForTest();
  resetMovedForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DrawerMap", () => {
  it("draws the object's 2-hop neighbourhood, compact, with a link to the object map", async () => {
    await show("Deployment", "shop", "web");
    expect(
      g.backend.callsTo("resource_graph_subscribe").map((a) => a.namespaces),
    ).toEqual([["shop"]]);
    expect(screen.getByTestId("map-loading")).toBeTruthy();
    await g.send(demoSnapshot());
    const tab = screen.getByTestId("drawer-map");
    expect(tab.querySelector("p")?.textContent).toBe(
      "Owner references, selectors and mounts, 2 hops out.",
    );
    const open = screen.getByTestId("drawer-map-open");
    expect(open.getAttribute("aria-label")).toBe(
      "Open the full map for this deployment",
    );
    expect(open.getAttribute("href")).toBe(
      "/cluster/c1/map?focus=Deployment%2Fshop%2Fweb",
    );
    expect(screen.getAllByTestId("map-node").length).toBeGreaterThan(0);
    expect(node(DEMO.statefulSet)).toBeNull();
    expect(screen.queryByTestId("map-zoom-in")).toBeNull();
    expect(screen.queryByTestId("map-legend-toggle")).toBeNull();
    expect(screen.queryByTestId("drawer-map-details")).toBeNull();
    fireEvent.click(open);
    expect(screen.getByTestId("where").textContent).toBe(
      "/cluster/c1/map?focus=Deployment%2Fshop%2Fweb",
    );
  });

  it("shows the selected node's kind, name, status and connections; a row selects its node", async () => {
    await show("Deployment", "shop", "web");
    await g.send(demoSnapshot());
    fireEvent.click(node(DEMO.podA));
    const details = screen.getByTestId("drawer-map-details");
    expect(details.textContent).toContain("Pod");
    expect(details.textContent).toContain("web-7d9-a");
    expect(details.textContent).toContain("Connections");
    const service = screen
      .getAllByTestId("map-connection")
      .find((row) => row.getAttribute("data-id") === DEMO.service);
    expect(service?.getAttribute("data-rel")).toBe("selects");
    expect(service?.getAttribute("data-dir")).toBe("in");
    fireEvent.click(service as HTMLElement);
    expect(
      screen.getByTestId("drawer-map-details").getAttribute("aria-label"),
    ).toBe("Service web");
    expect(node(DEMO.service).getAttribute("aria-selected")).toBe("true");
  });

  it("says when the object is gone", async () => {
    await show("Deployment", "shop", "gone");
    await g.send(demoSnapshot());
    expect(screen.getByTestId("map-empty").textContent).toContain(
      "Deployment gone no longer exists.",
    );
    fireEvent.click(screen.getByTestId("map-to-cluster"));
    expect(screen.getByTestId("where").textContent).toBe("/cluster/c1/map");
  });

  it("shows a failure with Retry", async () => {
    await show("Pod", "shop", "web-7d9-a");
    await g.send({ type: "failure", message: "watch ended" });
    expect(screen.getByTestId("map-error").textContent).toContain(
      "The map could not be built: watch ended",
    );
    fireEvent.click(screen.getByTestId("map-retry"));
    await act(flush);
    expect(g.backend.callsTo("resource_graph_subscribe")).toHaveLength(2);
  });
});

describe("hasDrawerMap", () => {
  it("is offered for the spec's kinds in their own API groups only", () => {
    for (const [kind, group] of [
      ["Pod", ""],
      ["Deployment", "apps"],
      ["ReplicaSet", "apps"],
      ["StatefulSet", "apps"],
      ["DaemonSet", "apps"],
      ["Job", "batch"],
      ["CronJob", "batch"],
      ["Service", ""],
      ["Ingress", "networking.k8s.io"],
      ["Gateway", "gateway.networking.k8s.io"],
      ["HTTPRoute", "gateway.networking.k8s.io"],
    ]) {
      expect([kind, hasDrawerMap({ kind, group })]).toEqual([kind, true]);
    }
    expect(hasDrawerMap({ kind: "ConfigMap", group: "" })).toBe(false);
    expect(
      hasDrawerMap({
        kind: "GatewayClass",
        group: "gateway.networking.k8s.io",
      }),
    ).toBe(false);
    expect(
      hasDrawerMap({ kind: "Gateway", group: "gateway.networking.x-k8s.io" }),
    ).toBe(false);
    expect(hasDrawerMap({ kind: "toString", group: "" })).toBe(false);
  });
});
