import { expect, test } from "vitest";
import type { KubeObject } from "../../kinds/objects";
import { usageItem, usageSnapshot } from "../../test/metrics";
import { gauge, nodeAllocatable, SOURCE_NAME, snapshotTotals } from "./gauges";

const GIB = 2 ** 30;

function node(name: string, allocatable?: Record<string, string>): KubeObject {
  return {
    apiVersion: "v1",
    kind: "Node",
    metadata: { name },
    status: allocatable ? { allocatable } : {},
  };
}

test("a CPU gauge reads cores with at most one decimal", () => {
  expect(gauge(1.5, 4, "cores", "Prometheus")).toEqual({
    value: 37.5,
    caption: "1.5 of 4 cores · Prometheus",
  });
  expect(gauge(0.123, 2.25, "cores", "metrics-server").caption).toBe(
    "0.1 of 2.3 cores · metrics-server",
  );
});

test("a memory gauge reads GiB with at most one decimal", () => {
  expect(gauge(3 * GIB, 16 * GIB, "bytes", "metrics-server")).toEqual({
    value: 18.75,
    caption: "3 of 16 GiB · metrics-server",
  });
  expect(gauge(1.25 * GIB, 15.6 * GIB, "bytes", "Prometheus").caption).toBe(
    "1.3 of 15.6 GiB · Prometheus",
  );
});

test.each([
  [null, 4],
  [1, null],
  [Number.NaN, 4],
  [1, Number.POSITIVE_INFINITY],
  [-1, 4],
  [1, 0],
])(
  "no usable usage or allocatable (%s of %s) reads No data",
  (used, allocatable) => {
    expect(gauge(used, allocatable, "cores", "Prometheus")).toEqual({
      value: null,
      caption: "No data",
    });
  },
);

test("the source names", () => {
  expect(SOURCE_NAME).toEqual({
    prometheus: "Prometheus",
    metricsServer: "metrics-server",
  });
});

test("nodeAllocatable sums the nodes' allocatable quantities", () => {
  expect(
    nodeAllocatable([
      node("a", { cpu: "2", memory: "8Gi" }),
      node("b", { cpu: "1500m", memory: "4Gi" }),
      node("c"),
    ]),
  ).toEqual({ cores: 3.5, bytes: 12 * GIB });
  expect(nodeAllocatable([node("c")])).toEqual({ cores: null, bytes: null });
  expect(nodeAllocatable([])).toEqual({ cores: null, bytes: null });
});

test("snapshotTotals sums a snapshot, and has nothing for no snapshot or no item", () => {
  expect(
    snapshotTotals(
      usageSnapshot([
        usageItem({ name: "a", cpuCores: 0.5, memoryBytes: 2 * GIB }),
        usageItem({ name: "b", cpuCores: 0.25, memoryBytes: GIB }),
      ]),
    ),
  ).toEqual({ cores: 0.75, bytes: 3 * GIB });
  expect(snapshotTotals(null)).toEqual({ cores: null, bytes: null });
  expect(snapshotTotals(usageSnapshot([]))).toEqual({
    cores: null,
    bytes: null,
  });
});
