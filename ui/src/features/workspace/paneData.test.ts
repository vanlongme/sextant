import { expect, test } from "vitest";
import { CONNECTED } from "../../test/terminal";
import { wsTab } from "../../test/workspace";
import { fullScreenPath, paneMeta } from "./paneData";

const INFO = CONNECTED.status === "connected" ? CONNECTED.info : null;

test("the full cluster screen is the cluster, its Pods list or its Events list", () => {
  expect([
    fullScreenPath(wsTab("t1", "prod eu", { view: "overview" })),
    fullScreenPath(wsTab("t1", "prod eu", { view: "pods" })),
    fullScreenPath(wsTab("t1", "prod eu", { view: "events" })),
  ]).toEqual([
    "/cluster/prod%20eu",
    "/cluster/prod%20eu/r/core/pods",
    "/cluster/prod%20eu/r/core/events",
  ]);
});

test("the meta line leaves out what is not known yet", () => {
  const nodes = { ready: 1, total: 2 };
  expect([
    paneMeta({ info: INFO, nodes, namespace: "shop" }),
    paneMeta({ info: INFO, nodes, namespace: null }),
    paneMeta({ info: INFO, nodes: null, namespace: undefined }),
    paneMeta({ info: null, nodes: null, namespace: "shop" }),
    paneMeta({ info: null, nodes: null, namespace: undefined }),
  ]).toEqual([
    "kind v1.33.1 · 1 of 2 nodes ready · namespace shop",
    "kind v1.33.1 · 1 of 2 nodes ready · all namespaces",
    "kind v1.33.1",
    "namespace shop",
    "",
  ]);
});
