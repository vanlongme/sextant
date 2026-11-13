import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { DEMO, demoGraph, gnode, servedResource } from "../../test/graph";
import { MapDetails, type MapDetailsProps, placeLine } from "./MapDetails";
import { buildModel } from "./model";

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

function show(id: string, over: Partial<MapDetailsProps> = {}) {
  const { nodes, edges } = demoGraph();
  const props: MapDetailsProps = {
    model: buildModel(nodes, edges),
    id,
    clusterId: "c1",
    resources: [
      servedResource("Pod", "", "pods"),
      servedResource("Deployment", "apps", "deployments"),
    ],
    onSelect: vi.fn(),
    onClose: vi.fn(),
    onFocus: vi.fn(),
    ...over,
  };
  render(
    <MemoryRouter initialEntries={["/cluster/c1/map"]}>
      <Routes>
        <Route path="*" element={<MapDetails {...props} />} />
      </Routes>
      <Where />
    </MemoryRouter>,
  );
  return props;
}

const facts = () =>
  screen
    .getAllByTestId("map-fact")
    .map((el) => [el.getAttribute("data-label"), el.textContent]);

const connections = () =>
  screen
    .queryAllByTestId("map-connection")
    .map(
      (el) =>
        `${el.getAttribute("data-dir")} ${el.getAttribute("data-rel")} ${el.getAttribute("data-id")}: ${el.textContent}`,
    );

describe("MapDetails", () => {
  it("shows the head, the facts and the age", () => {
    show(DEMO.podA);
    const pane = within(screen.getByTestId("map-details"));
    expect(pane.getByText("Pod in shop")).toBeTruthy();
    expect(pane.getByRole("heading", { level: 2 }).textContent).toBe(
      "web-7d9-a",
    );
    expect(pane.getByRole("img", { name: "Running" })).toBeTruthy();
    expect(facts().map(([label]) => label)).toEqual([
      "Ready",
      "Restarts",
      "Node",
      "Age",
    ]);
    expect(facts()[0]).toEqual(["Ready", "Ready1/1"]);
  });

  it("falls back to the status word without a status text", () => {
    expect(placeLine(gnode("GatewayClass//shared"))).toBe(
      "GatewayClass · cluster scope",
    );
    expect(placeLine(gnode("LoadBalancer//10.0.0.5"))).toBe(
      "Outside the cluster",
    );
    show(DEMO.token);
    expect(screen.getByRole("img", { name: "No health status" })).toBeTruthy();
    expect(screen.queryByTestId("map-details")?.textContent).toContain(
      "No health status",
    );
  });

  it("labels the relations in both directions", () => {
    show(DEMO.podA);
    expect(connections()).toEqual([
      `out mounts ${DEMO.configMap}: Mounts ConfigMapweb-config`,
      `out env ${DEMO.secret}: Reads env from Secretweb-secret`,
      `out runsAs ${DEMO.account}: Runs as ServiceAccountweb`,
      `out claims ${DEMO.claim}: Claims PersistentVolumeClaimdata-web`,
      `in owns ${DEMO.replicaSet}: Owned by ReplicaSetweb-7d9`,
      `in selects ${DEMO.service}: Selected by Serviceweb`,
    ]);
  });

  it("reads routes, classes and identities from the other side", () => {
    show(DEMO.gateway);
    expect(connections()).toEqual([
      `out routes ${DEMO.route}: Routes to HTTPRouteweb`,
      `out class ${DEMO.gatewayClass}: Uses class GatewayClassshared`,
      `in routes ${DEMO.gatewayLb}: Routed from LoadBalancer203.0.113.24`,
    ]);
  });

  it("collapses the Pods of one owner and expands them on click", () => {
    show(DEMO.configMap);
    expect(connections()).toEqual([]);
    const group = screen.getByTestId("map-connection-group");
    expect(group.textContent).toBe("Mounted by 2 Pods of web-7d9");
    expect(group.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(group);
    expect(connections()).toEqual([
      `in mounts ${DEMO.podA}: Mounted by Podweb-7d9-a`,
      `in mounts ${DEMO.podB}: Mounted by Podweb-7d9-b`,
    ]);
  });

  it("selects the node of a row", () => {
    const props = show(DEMO.account);
    fireEvent.click(screen.getByTestId("map-connection-group"));
    fireEvent.click(screen.getAllByTestId("map-connection")[1]);
    expect(props.onSelect).toHaveBeenCalledWith(DEMO.podB);
  });

  it("offers Show map for a focusable kind but not the current focus", () => {
    const props = show(DEMO.deployment);
    const focus = screen.getByTestId("map-details-focus");
    expect(focus.textContent).toBe("Show map for this Deployment");
    fireEvent.click(focus);
    expect(props.onFocus).toHaveBeenCalledWith(DEMO.deployment);
  });

  it("hides Show map for the focus and for config", () => {
    show(DEMO.deployment, { focusId: DEMO.deployment });
    expect(screen.queryByTestId("map-details-focus")).toBeNull();
  });

  it("hides Show map for a ConfigMap", () => {
    show(DEMO.configMap);
    expect(screen.queryByTestId("map-details-focus")).toBeNull();
  });

  it("opens the object in its list when discovery lists it", () => {
    show(DEMO.podA);
    const open = screen.getByTestId("map-details-open");
    expect(open.textContent).toBe("Open in Pods");
    fireEvent.click(open);
    expect(screen.getByTestId("where").textContent).toBe(
      "/cluster/c1/r/core/pods?object=shop%2Fweb-7d9-a",
    );
  });

  it("offers no list when discovery does not list the kind", () => {
    show(DEMO.configMap);
    expect(screen.queryByTestId("map-details-open")).toBeNull();
  });

  it("closes", () => {
    const props = show(DEMO.podA);
    fireEvent.click(screen.getByTestId("map-details-close"));
    expect(props.onClose).toHaveBeenCalled();
  });
});
