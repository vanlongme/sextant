import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { MetricsTarget } from "../../ipc/generated/MetricsTarget";
import { resetCatalogForTest } from "../../stores/catalog";
import { forgetProvider, resetMetricsForTest } from "../../stores/metrics";
import { flush, mockBackend } from "../../test/ipc";
import {
  metricsResult,
  points,
  prometheus,
  T0,
  usageItem,
  usageSnapshot,
} from "../../test/metrics";
import { connectClusters } from "../../test/terminal";
import {
  useProvider,
  useQueryWatch,
  useSecondsUntil,
  useUsageWatch,
  useUsageWatches,
} from "./hooks";

beforeEach(() => {
  resetMetricsForTest();
  resetCatalogForTest();
  connectClusters({ id: "c1", name: "kind-dev" });
});

afterEach(() => {
  vi.useRealTimers();
});

test("useProvider loads the provider once for every user, and again after forgetProvider", async () => {
  const backend = mockBackend({ metrics_provider: () => prometheus() });
  const first = renderHook(() => useProvider("c1"));
  const second = renderHook(() => useProvider("c1"));
  await act(flush);

  expect(backend.callsTo("metrics_provider")).toEqual([
    { clusterId: "c1", refresh: false },
  ]);
  expect(first.result.current?.value).toEqual(prometheus());
  expect(second.result.current?.value).toEqual(prometheus());

  act(() => forgetProvider("c1"));
  await act(flush);

  expect(backend.callsTo("metrics_provider")).toEqual([
    { clusterId: "c1", refresh: false },
    { clusterId: "c1", refresh: false },
  ]);
  expect(first.result.current?.value).toEqual(prometheus());
});

test("useQueryWatch follows the query's key, not the target object, and watches nothing for null", async () => {
  const backend = mockBackend({
    metrics_query: () => metricsResult({ cpuUsage: points([0.5]) }),
  });
  const { result, rerender, unmount } = renderHook(
    (p: { target: MetricsTarget | null }) =>
      useQueryWatch("c1", p.target, "1h"),
    { initialProps: { target: { kind: "cluster" } } },
  );
  await act(flush);

  expect(backend.callsTo("metrics_query")).toEqual([
    { clusterId: "c1", target: { kind: "cluster" }, range: "1h" },
  ]);
  expect(result.current?.value?.series.cpuUsage).toEqual(points([0.5]));

  rerender({ target: { kind: "cluster" } });
  await act(flush);
  expect(backend.callsTo("metrics_query")).toHaveLength(1);

  rerender({ target: null });
  expect(result.current).toBeUndefined();
  unmount();
});

test("useUsageWatch watches only while enabled", async () => {
  const backend = mockBackend({
    metrics_usage: () => usageSnapshot([usageItem({ name: "web-1" })]),
  });
  const { result, rerender } = renderHook(
    (p: { enabled: boolean }) => useUsageWatch("c1", "pods", "shop", p.enabled),
    { initialProps: { enabled: false } },
  );
  await act(flush);
  expect(backend.callsTo("metrics_usage")).toEqual([]);
  expect(result.current).toBeUndefined();

  rerender({ enabled: true });
  await act(flush);
  expect(backend.callsTo("metrics_usage")).toEqual([
    { clusterId: "c1", of: "pods", namespace: "shop" },
  ]);
  expect(result.current?.value?.items.map((i) => i.name)).toEqual(["web-1"]);
});

test("useUsageWatches watches each namespace once and returns the slices in order", async () => {
  const backend = mockBackend({
    metrics_usage: (a: { namespace: string | null }) =>
      usageSnapshot([
        usageItem({ namespace: a.namespace, name: `web-${a.namespace}` }),
      ]),
  });
  const { result, rerender, unmount } = renderHook(() =>
    useUsageWatches("c1", "pods", ["shop", "data"], true),
  );
  await act(flush);

  expect(backend.callsTo("metrics_usage")).toEqual([
    { clusterId: "c1", of: "pods", namespace: "shop" },
    { clusterId: "c1", of: "pods", namespace: "data" },
  ]);
  expect(result.current.map((s) => s.value?.items[0]?.name)).toEqual([
    "web-shop",
    "web-data",
  ]);

  // A new array with the same namespaces keeps the same watches.
  rerender();
  await act(flush);
  expect(backend.callsTo("metrics_usage")).toHaveLength(2);
  unmount();
});

test("useSecondsUntil counts down each second, stops at zero, and is null without a time", () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(T0 * 1000);
  const first: { at: number | null } = { at: T0 * 1000 + 15_000 };
  const { result, rerender } = renderHook(
    (p: { at: number | null }) => useSecondsUntil(p.at),
    { initialProps: first },
  );
  expect(result.current).toBe(15);

  act(() => {
    vi.advanceTimersByTime(4_000);
  });
  expect(result.current).toBe(11);

  act(() => {
    vi.advanceTimersByTime(20_000);
  });
  expect(result.current).toBe(0);

  rerender({ at: null });
  expect(result.current).toBeNull();
});
