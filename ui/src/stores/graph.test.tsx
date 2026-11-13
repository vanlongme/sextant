import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { demoSnapshot, graphBackend } from "../test/graph";
import { flush } from "../test/ipc";
import {
  filterKey,
  graphKey,
  resetGraphForTest,
  retryGraph,
  useGraph,
  useGraphStore,
  watchGraph,
} from "./graph";

beforeEach(() => resetGraphForTest());
afterEach(() => resetGraphForTest());

const entry = (clusterId: string, namespaces: string[] | null) =>
  useGraphStore.getState().entries[graphKey(clusterId, namespaces)];

test("the filter key is the sorted namespaces joined by commas, or * for all", () => {
  expect(filterKey(null)).toBe("*");
  expect(filterKey(["shop", "edge"])).toBe("edge,shop");
  expect(filterKey([])).toBe("");
  expect(graphKey("c1", ["b", "a"])).toBe(graphKey("c1", ["a", "b"]));
  expect(graphKey("c1", null)).not.toBe(graphKey("c2", null));
});

test("watchers of one filter share a subscription, and the last to leave ends it", async () => {
  const g = graphBackend();
  const first = watchGraph("c1", ["shop", "edge"]);
  const second = watchGraph("c1", ["edge", "shop"]);
  await act(flush);
  expect(g.backend.callsTo("resource_graph_subscribe")).toMatchObject([
    { clusterId: "c1", namespaces: ["edge", "shop"] },
  ]);
  expect(entry("c1", ["edge", "shop"])).toEqual({
    snapshot: null,
    error: null,
    loading: true,
  });

  first();
  first();
  await act(flush);
  expect(g.backend.callsTo("resource_graph_unsubscribe")).toEqual([]);

  second();
  await act(flush);
  expect(g.backend.callsTo("resource_graph_unsubscribe")).toEqual([
    { subscriptionId: "g1" },
  ]);
  expect(entry("c1", ["edge", "shop"])).toBeUndefined();
});

test("null watches every namespace under its own subscription", async () => {
  const g = graphBackend();
  const all = watchGraph("c1", null);
  const shop = watchGraph("c1", ["shop"]);
  await act(flush);
  expect(
    g.backend
      .callsTo("resource_graph_subscribe")
      .map((args) => args.namespaces),
  ).toEqual([null, ["shop"]]);
  all();
  shop();
});

test("a snapshot fills the entry; a failure keeps it and sets the error", async () => {
  const g = graphBackend();
  const stop = watchGraph("c1", null);
  await act(flush);
  const snapshot = demoSnapshot();
  await g.send(snapshot);
  expect(entry("c1", null)).toEqual({ snapshot, error: null, loading: false });

  await g.send({ type: "failure", message: "Discovery failed" });
  expect(entry("c1", null)).toEqual({
    snapshot,
    error: "Discovery failed",
    loading: false,
  });
  stop();
  await act(flush);
  // A failure ended the subscription, so there is nothing left to end.
  expect(g.backend.callsTo("resource_graph_unsubscribe")).toEqual([]);
});

test("retry subscribes again, keeps the snapshot while it loads and ignores the old channel", async () => {
  const g = graphBackend();
  const stop = watchGraph("c1", ["shop"]);
  await act(flush);
  const snapshot = demoSnapshot();
  await g.send(snapshot, "g1");
  await g.send({ type: "failure", message: "boom" }, "g1");

  act(() => retryGraph("c1", ["shop"]));
  expect(entry("c1", ["shop"])).toEqual({
    snapshot,
    error: null,
    loading: true,
  });
  await act(flush);
  expect(g.backend.callsTo("resource_graph_subscribe")).toHaveLength(2);

  await act(async () => {
    g.channel("g1")({ type: "failure", message: "late" });
    await flush();
  });
  expect(entry("c1", ["shop"])?.error).toBeNull();
  const next = demoSnapshot({ missing: ["secrets"] });
  await g.send(next, "g2");
  expect(entry("c1", ["shop"])).toEqual({
    snapshot: next,
    error: null,
    loading: false,
  });

  act(() => retryGraph("c1", ["shop"]));
  await act(flush);
  expect(g.backend.callsTo("resource_graph_unsubscribe")).toEqual([
    { subscriptionId: "g2" },
  ]);
  stop();
});

test("retry of a filter nobody watches does nothing", async () => {
  const g = graphBackend();
  act(() => retryGraph("c1", null));
  await act(flush);
  expect(g.backend.calls).toEqual([]);
});

test("a refused subscribe call shows its message", async () => {
  const g = graphBackend({
    resource_graph_subscribe: () => {
      throw { code: "InvalidInput", message: "The cluster is not connected" };
    },
  });
  const stop = watchGraph("c1", null);
  await act(flush);
  expect(entry("c1", null)).toEqual({
    snapshot: null,
    error: "The cluster is not connected",
    loading: false,
  });
  stop();
  await act(flush);
  expect(g.backend.callsTo("resource_graph_unsubscribe")).toEqual([]);
});

test("a watcher that leaves before the id arrives ends the subscription when it does", async () => {
  let answer: (id: string) => void = () => {};
  const g = graphBackend({
    resource_graph_subscribe: () =>
      new Promise<string>((resolve) => {
        answer = resolve;
      }),
  });
  const stop = watchGraph("c1", null);
  await act(flush);
  stop();
  await act(async () => {
    answer("late-id");
    await flush();
  });
  expect(g.backend.callsTo("resource_graph_unsubscribe")).toEqual([
    { subscriptionId: "late-id" },
  ]);
  expect(entry("c1", null)).toBeUndefined();
});

function Probe(props: { clusterId: string; namespaces: string[] | null }) {
  const graph = useGraph(props.clusterId, props.namespaces);
  return (
    <div>
      <span data-testid="state">
        {graph.loading
          ? "loading"
          : graph.error
            ? `error ${graph.error}`
            : `nodes ${graph.snapshot?.nodes.length}`}
      </span>
      <button type="button" onClick={graph.retry}>
        Retry
      </button>
    </div>
  );
}

test("useGraph watches while mounted and follows its filter", async () => {
  const g = graphBackend();
  const view = render(<Probe clusterId="c1" namespaces={["shop"]} />);
  expect(screen.getByTestId("state").textContent).toBe("loading");
  await act(flush);
  await g.send(demoSnapshot());
  expect(screen.getByTestId("state").textContent).toBe("nodes 22");

  view.rerender(<Probe clusterId="c1" namespaces={["shop"]} />);
  await act(flush);
  expect(g.backend.callsTo("resource_graph_subscribe")).toHaveLength(1);

  view.rerender(<Probe clusterId="c1" namespaces={null} />);
  await act(flush);
  expect(screen.getByTestId("state").textContent).toBe("loading");
  expect(g.backend.callsTo("resource_graph_unsubscribe")).toEqual([
    { subscriptionId: "g1" },
  ]);

  await g.send({ type: "failure", message: "boom" });
  expect(screen.getByTestId("state").textContent).toBe("error boom");
  await act(async () => {
    screen.getByRole("button", { name: "Retry" }).click();
    await flush();
  });
  expect(g.backend.callsTo("resource_graph_subscribe")).toHaveLength(3);

  view.unmount();
  await act(flush);
  expect(g.open()).toEqual([]);
});
