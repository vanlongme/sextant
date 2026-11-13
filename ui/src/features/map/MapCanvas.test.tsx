import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO, demoGraph, gedge, gnode } from "../../test/graph";
import { mockElementSize } from "../../test/size";
import { MapCanvas, type MapCanvasProps, resetMovedForTest } from "./MapCanvas";
import { buildModel } from "./model";
import type { LayoutName } from "./scene";

function demoModel() {
  const { nodes, edges } = demoGraph();
  return buildModel(nodes, edges);
}

function draw(over: Partial<MapCanvasProps> = {}) {
  const model = over.model ?? demoModel();
  const props: MapCanvasProps = {
    model,
    ids: model.nodes.map((n) => n.id),
    layout: "grouped",
    page: "cluster",
    memoryKey: "c1|cluster|grouped",
    selected: null,
    onSelect: vi.fn(),
    ...over,
  };
  const view = render(<MapCanvas {...props} />);
  return { ...view, props };
}

const node = (id: string) =>
  screen
    .getAllByTestId("map-node")
    .find((el) => el.getAttribute("data-id") === id) as Element;

const edges = () =>
  screen
    .getAllByTestId("map-edge")
    .map(
      (el) =>
        `${el.getAttribute("data-from")} ${el.getAttribute("data-rel")} ${el.getAttribute("data-to")}`,
    );

const zoom = () => screen.getByTestId("map-zoom-label").textContent;

beforeEach(() => {
  mockElementSize(1000, 600);
  resetMovedForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MapCanvas", () => {
  it("is one tab stop with the spec's label", () => {
    draw();
    const canvas = screen.getByTestId("map-canvas");
    expect(canvas.getAttribute("role")).toBe("application");
    expect(canvas.tabIndex).toBe(0);
    expect(canvas.getAttribute("aria-label")).toBe(
      "Resource map. Drag to pan, scroll to zoom, select a resource to see its connections.",
    );
  });

  it("draws every node with its test attributes, owners as boxes in Grouped", () => {
    draw();
    expect(screen.getAllByTestId("map-node")).toHaveLength(22);
    const pod = node(DEMO.podB);
    expect(pod.getAttribute("data-kind")).toBe("Pod");
    expect(pod.getAttribute("data-status")).toBe("critical");
    expect(pod.getAttribute("aria-selected")).toBe("false");
    expect(node(DEMO.deployment).querySelector("rect")).not.toBeNull();
    expect(
      screen
        .getAllByTestId("map-namespace")
        .map((el) => el.getAttribute("data-namespace")),
    ).toEqual(["edge", "jobs", "shop"]);
    expect(edges()).toContain(`${DEMO.service} selects ${DEMO.replicaSet}`);
    expect(edges().some((e) => e.includes(" owns "))).toBe(false);
  });

  it.each<LayoutName>(["layered", "force"])(
    "draws owns as lines and namespaces as areas in %s",
    (layout) => {
      draw({
        layout,
        memoryKey: `c1|cluster|${layout}`,
        selected: DEMO.gateway,
      });
      expect(screen.getAllByTestId("map-node")).toHaveLength(22);
      expect(edges()).toContain(`${DEMO.deployment} owns ${DEMO.replicaSet}`);
      expect(edges()).toContain(`${DEMO.podA} mounts ${DEMO.configMap}`);
      expect(screen.getAllByTestId("map-namespace")).toHaveLength(3);
    },
  );

  it("draws edges between namespaces under Force only for the selection", () => {
    draw({ layout: "force", memoryKey: "c1|cluster|force" });
    expect(edges()).not.toContain(`${DEMO.gateway} routes ${DEMO.route}`);
    expect(edges()).toContain(`${DEMO.route} routes ${DEMO.service}`);
  });

  it("dims the nodes the search does not match", () => {
    draw({ search: "WEB-7D9-A" });
    expect(node(DEMO.podA).classList.contains("dim")).toBe(false);
    expect(node(DEMO.podB).classList.contains("dim")).toBe(true);
    expect(node(DEMO.deployment).classList.contains("dim")).toBe(true);
  });

  it("outlines the selection and announces it", () => {
    draw({ selected: DEMO.podB });
    expect(node(DEMO.podB).getAttribute("aria-selected")).toBe("true");
    expect(node(DEMO.podB).classList.contains("selected")).toBe(true);
    expect(screen.getByTestId("map-live").textContent).toBe(
      "Pod web-7d9-b, CrashLoopBackOff",
    );
  });

  it("selects a node on click", () => {
    const { props } = draw();
    fireEvent.click(node(DEMO.service));
    expect(props.onSelect).toHaveBeenCalledWith(DEMO.service);
  });

  it("moves the selection to the nearest node with the arrow keys", () => {
    const service = gnode("Service/a/s");
    const a = gnode("Pod/a/a");
    const b = gnode("Pod/a/b");
    const model = buildModel(
      [service, a, b],
      [gedge(service.id, "selects", a.id), gedge(service.id, "selects", b.id)],
    );
    const onSelect = vi.fn();
    const { rerender, props } = draw({
      model,
      ids: [service.id, a.id, b.id],
      layout: "layered",
      page: "object",
      memoryKey: "c1|object|layered",
      onSelect,
    });
    const canvas = screen.getByTestId("map-canvas");
    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    expect(onSelect).toHaveBeenLastCalledWith(service.id);
    rerender(<MapCanvas {...props} selected={a.id} />);
    fireEvent.keyDown(canvas, { key: "ArrowDown" });
    expect(onSelect).toHaveBeenLastCalledWith(b.id);
    fireEvent.keyDown(canvas, { key: "ArrowLeft" });
    expect(onSelect).toHaveBeenLastCalledWith(service.id);
    onSelect.mockClear();
    fireEvent.keyDown(canvas, { key: "ArrowUp" });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("clears the selection with Esc", () => {
    const { props } = draw({ selected: DEMO.podA });
    fireEvent.keyDown(screen.getByTestId("map-canvas"), { key: "Escape" });
    expect(props.onSelect).toHaveBeenCalledWith(null);
  });

  it("zooms with the buttons and the keys, and 0 fits", () => {
    draw();
    const fitted = zoom();
    fireEvent.click(screen.getByTestId("map-zoom-in"));
    expect(zoom()).toBe(
      `${Math.round(Number.parseInt(fitted ?? "", 10) * 1.25)}%`,
    );
    fireEvent.keyDown(screen.getByTestId("map-canvas"), { key: "0" });
    expect(zoom()).toBe(fitted);
    fireEvent.keyDown(screen.getByTestId("map-canvas"), { key: "-" });
    expect(zoom()).not.toBe(fitted);
    fireEvent.click(screen.getByTestId("map-fit"));
    expect(zoom()).toBe(fitted);
    for (let i = 0; i < 20; i++) {
      fireEvent.keyDown(screen.getByTestId("map-canvas"), { key: "=" });
    }
    expect(zoom()).toBe("400%");
  });

  it("keeps a moved node in place after a new snapshot, until Reset layout", () => {
    const { rerender, props } = draw({
      layout: "layered",
      memoryKey: "c1|cluster|layered",
    });
    const before = node(DEMO.podA).getAttribute("transform");
    const world = screen.getByTestId("map-canvas").querySelector("svg > g");
    const k = Number(
      /scale\(([\d.]+)\)/.exec(world?.getAttribute("transform") ?? "")?.[1],
    );
    fireEvent.pointerDown(node(DEMO.podA), {
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(window, { clientX: 110, clientY: 60 });
    fireEvent.pointerUp(window);
    const after = node(DEMO.podA).getAttribute("transform");
    expect(after).not.toBe(before);
    const [x0, y0] = (before ?? "").match(/-?[\d.]+/g)?.map(Number) ?? [];
    const [x1, y1] = (after ?? "").match(/-?[\d.]+/g)?.map(Number) ?? [];
    expect(x1 - x0).toBeCloseTo(100 / k, 3);
    expect(y1 - y0).toBeCloseTo(50 / k, 3);

    rerender(<MapCanvas {...props} model={demoModel()} />);
    expect(node(DEMO.podA).getAttribute("transform")).toBe(after);

    rerender(<MapCanvas {...props} model={demoModel()} resetSignal={1} />);
    expect(node(DEMO.podA).getAttribute("transform")).toBe(before);
  });

  it("does not select a node at the end of a drag", () => {
    const { props } = draw();
    fireEvent.pointerDown(node(DEMO.podA), {
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(window, { clientX: 60, clientY: 10 });
    fireEvent.pointerUp(window);
    fireEvent.click(node(DEMO.podA));
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("does not refit the view while a node is dragged", () => {
    draw();
    const fitted = zoom();
    fireEvent.pointerDown(node(DEMO.podA), {
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(window, { clientX: 810, clientY: 10 });
    expect(zoom()).toBe(fitted);
    fireEvent.pointerUp(window);
    expect(zoom()).toBe(fitted);
  });

  it("centres a node on demand at the same zoom", () => {
    const { rerender, props } = draw({
      layout: "layered",
      memoryKey: "c1|cluster|layered",
    });
    const world = () =>
      screen
        .getByTestId("map-canvas")
        .querySelector("svg > g")
        ?.getAttribute("transform") ?? "";
    const [, , k] =
      world()
        .match(/-?[\d.]+/g)
        ?.map(Number) ?? [];
    const [x, y] =
      node(DEMO.podA)
        .getAttribute("transform")
        ?.match(/-?[\d.]+/g)
        ?.map(Number) ?? [];
    rerender(<MapCanvas {...props} centre={{ id: DEMO.podA, n: 1 }} />);
    const [tx, ty, k2] =
      world()
        .match(/-?[\d.]+/g)
        ?.map(Number) ?? [];
    expect(k2).toBe(k);
    expect(tx + x * k).toBeCloseTo(500, 3);
    expect(ty + y * k).toBeCloseTo(300, 3);
  });

  it("compact: fits the width at most 100%, is as tall as the drawing, with no controls", () => {
    draw({ compact: true, page: "object", flow: "v", focusId: DEMO.podA });
    expect(screen.queryByTestId("map-zoom-in")).toBeNull();
    expect(screen.queryByTestId("map-fit")).toBeNull();
    expect(screen.queryByTestId("map-legend-toggle")).toBeNull();
    const canvas = screen.getByTestId("map-canvas");
    expect(canvas.getAttribute("aria-label")).toBe(
      "Resource map. Select a resource to see its connections.",
    );
    const svg = canvas.querySelector("svg") as SVGSVGElement;
    const [tx, ty, k] =
      svg
        .querySelector("g")
        ?.getAttribute("transform")
        ?.match(/-?[\d.]+/g)
        ?.map(Number) ?? [];
    expect(k).toBeLessThanOrEqual(1);
    expect(tx).toBeGreaterThanOrEqual(24 - 1e-6);
    expect(ty).toBeDefined();
    expect(Number(svg.getAttribute("height"))).toBeGreaterThan(48);
  });

  it("compact: a click selects, but drags, the wheel and zoom keys do nothing", () => {
    const { props } = draw({ compact: true, page: "object", flow: "v" });
    const canvas = screen.getByTestId("map-canvas");
    const world = () =>
      canvas.querySelector("svg > g")?.getAttribute("transform");
    const before = node(DEMO.podA).getAttribute("transform");
    const view = world();
    fireEvent.pointerDown(node(DEMO.podA), {
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(window, { clientX: 110, clientY: 60 });
    fireEvent.pointerUp(window);
    fireEvent.pointerDown(canvas, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 110, clientY: 60 });
    fireEvent.pointerUp(window);
    fireEvent.wheel(canvas, { deltaY: -200 });
    fireEvent.keyDown(canvas, { key: "+" });
    expect(node(DEMO.podA).getAttribute("transform")).toBe(before);
    expect(world()).toBe(view);
    fireEvent.click(node(DEMO.podA));
    expect(props.onSelect).toHaveBeenCalledWith(DEMO.podA);
  });

  it("shows the legend on demand", () => {
    draw();
    expect(screen.queryByTestId("map-legend")).toBeNull();
    const toggle = screen.getByTestId("map-legend-toggle");
    expect(toggle.getAttribute("aria-label")).toBe("Show or hide the legend");
    fireEvent.click(toggle);
    const legend = within(screen.getByTestId("map-legend"));
    expect(legend.getByText("Legend")).toBeTruthy();
    for (const text of [
      "Healthy",
      "Pending or degraded",
      "Failing",
      "Config or completed",
      "Box holds what it owns",
      "Outside the cluster (load balancers)",
      "Owns",
      "Routes traffic: LB, Gateway, Route, Ingress, Service",
      "Mounts or uses (config, GatewayClass)",
    ]) {
      expect(legend.getByText(text)).toBeTruthy();
    }
  });
});
