import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { UsageItem } from "../ipc/generated/UsageItem";
import { flush, mockBackend } from "../test/ipc";
import {
  FORBIDDEN,
  metricsServer,
  NO_METRICS_SERVER,
  prometheus,
  T0,
  UNREACHABLE,
  usageItem,
  usageSnapshot,
} from "../test/metrics";
import { connectClusters } from "../test/terminal";
import { resetCatalogForTest } from "./catalog";
import {
  askUsage,
  ensureProvider,
  forgetProvider,
  HISTORY_LIMIT,
  HISTORY_SECONDS,
  resetMetricsForTest,
  USAGE_POLL_MS,
  usageKey,
  useMetrics,
  watchUsage,
} from "./metrics";

beforeEach(() => {
  resetMetricsForTest();
  resetCatalogForTest();
  connectClusters({ id: "c1", name: "kind" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const metrics = () => useMetrics.getState();
const MiB = 2 ** 20;
const PODS = usageKey("c1", "pods", null);
const WEB = usageItem({ name: "web-1" });
const DB = usageItem({
  name: "db-0",
  namespace: "data",
  cpuCores: 0.5,
  memoryBytes: 128 * MiB,
});

function pollTimers(): void {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(T0 * 1000);
}

/** Answers each read with `items`, stamped with the (fake) time of the read. */
function servedNow(items: () => UsageItem[]) {
  return () => usageSnapshot(items(), Date.now() / 1000);
}

test("usage watchers share a poller that asks at once and every 15 s, and say when the next ask is due", async () => {
  pollTimers();
  const backend = mockBackend({ metrics_usage: servedNow(() => [WEB]) });
  const key = usageKey("c1", "pods", "shop");
  const stopA = watchUsage("c1", "pods", "shop");
  const stopB = watchUsage("c1", "pods", "shop");
  await flush();
  expect(backend.callsTo("metrics_usage")).toEqual([
    { clusterId: "c1", of: "pods", namespace: "shop" },
  ]);
  expect(metrics().usage[key]?.nextAt).toBe(T0 * 1000 + USAGE_POLL_MS);
  expect(metrics().usage[key]?.value?.items).toEqual([WEB]);

  vi.advanceTimersByTime(USAGE_POLL_MS);
  await flush();
  expect(backend.callsTo("metrics_usage")).toHaveLength(2);
  expect(metrics().usage[key]?.nextAt).toBe(T0 * 1000 + 2 * USAGE_POLL_MS);

  stopA();
  stopB();
  expect(metrics().usage[key]?.nextAt).toBeNull();
  vi.advanceTimersByTime(USAGE_POLL_MS);
  await flush();
  expect(backend.callsTo("metrics_usage")).toHaveLength(2);
});

test("usage asks follow the window's visibility like queries", async () => {
  pollTimers();
  const backend = mockBackend({ metrics_usage: servedNow(() => [WEB]) });
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("hidden");
  const stop = watchUsage("c1", "nodes", null);
  vi.advanceTimersByTime(2 * USAGE_POLL_MS);
  await flush();
  expect(backend.callsTo("metrics_usage")).toHaveLength(0);
  visibility.mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  await flush();
  expect(backend.callsTo("metrics_usage")).toHaveLength(1);
  stop();
});

test("each snapshot is kept and appended per item; a repeated timestamp is not appended", async () => {
  let at = T0;
  mockBackend({ metrics_usage: () => usageSnapshot([WEB, DB], at) });
  await askUsage("c1", "pods", null);
  await askUsage("c1", "pods", null);
  at = T0 + 15;
  await askUsage("c1", "pods", null);

  const slice = metrics().usage[PODS];
  expect(slice?.value).toEqual(usageSnapshot([WEB, DB], T0 + 15));
  expect(slice?.error).toBeNull();
  expect(slice?.loading).toBe(false);
  expect(slice?.history).toEqual({
    "shop/web-1": [
      { t: T0, cpu: 0.25, memory: 64 * MiB },
      { t: T0 + 15, cpu: 0.25, memory: 64 * MiB },
    ],
    "data/db-0": [
      { t: T0, cpu: 0.5, memory: 128 * MiB },
      { t: T0 + 15, cpu: 0.5, memory: 128 * MiB },
    ],
  });
});

test("node samples are keyed by the node name", async () => {
  mockBackend({
    metrics_usage: () =>
      usageSnapshot([
        usageItem({ name: "worker", namespace: null, cpuCores: 1.5 }),
      ]),
  });
  await askUsage("c1", "nodes", null);
  expect(
    Object.keys(metrics().usage[usageKey("c1", "nodes", null)]?.history ?? {}),
  ).toEqual(["worker"]);
});

test("the history keeps 240 samples per item and one hour; an item that left keeps its samples until they age out", async () => {
  let at = T0;
  let items = [WEB, DB];
  mockBackend({ metrics_usage: () => usageSnapshot(items, at) });
  for (let i = 0; i < 300; i += 1) {
    at = T0 + i;
    await askUsage("c1", "pods", null);
  }
  const web = () => metrics().usage[PODS]?.history["shop/web-1"] ?? [];
  const db = () => metrics().usage[PODS]?.history["data/db-0"] ?? [];
  expect(HISTORY_LIMIT).toBe(240);
  expect(web()).toHaveLength(240);
  expect(web()[0]?.t).toBe(T0 + 60);
  expect(web()[239]?.t).toBe(T0 + 299);

  items = [WEB];
  at = T0 + HISTORY_SECONDS + 100;
  await askUsage("c1", "pods", null);
  expect(db()).toHaveLength(199);
  expect(db()[0]?.t).toBe(T0 + 101);
  expect(web()).toHaveLength(200);

  at = T0 + HISTORY_SECONDS + 300;
  await askUsage("c1", "pods", null);
  expect(Object.keys(metrics().usage[PODS]?.history ?? {})).toEqual([
    "shop/web-1",
  ]);
  expect(web().map((s) => s.t)).toEqual([
    T0 + HISTORY_SECONDS + 100,
    T0 + HISTORY_SECONDS + 300,
  ]);
});

test("a usage error keeps the last snapshot; Unreachable shows no error", async () => {
  let answer: "ok" | "forbidden" | "gone" = "ok";
  const SNAPSHOT = usageSnapshot([WEB]);
  mockBackend({
    metrics_usage: () => {
      if (answer === "forbidden") throw FORBIDDEN;
      if (answer === "gone") throw UNREACHABLE;
      return SNAPSHOT;
    },
  });
  await askUsage("c1", "pods", null);
  answer = "forbidden";
  await askUsage("c1", "pods", null);
  expect(metrics().usage[PODS]?.value).toEqual(SNAPSHOT);
  expect(metrics().usage[PODS]?.error?.code).toBe("Forbidden");

  answer = "ok";
  await askUsage("c1", "pods", null);
  expect(metrics().usage[PODS]?.error).toBeNull();

  answer = "gone";
  await askUsage("c1", "pods", null);
  expect(metrics().usage[PODS]?.error).toBeNull();
  expect(metrics().usage[PODS]?.value).toEqual(SNAPSHOT);
  expect(metrics().usage[PODS]?.loading).toBe(false);
});

test("noMetricsServer stops the cluster's usage asks until forgetProvider, and reads a metrics-server provider again once", async () => {
  pollTimers();
  let served = false;
  const backend = mockBackend({
    metrics_provider: () => metricsServer(),
    metrics_usage: () => {
      if (!served) throw NO_METRICS_SERVER;
      return usageSnapshot([WEB], Date.now() / 1000);
    },
  });
  ensureProvider("c1");
  await flush();
  const stopPods = watchUsage("c1", "pods", null);
  const stopNodes = watchUsage("c1", "nodes", null);
  await flush();
  await flush();
  // One refresh after the first refusal; its answer lets both pollers try once more.
  expect(backend.callsTo("metrics_provider")).toEqual([
    { clusterId: "c1", refresh: false },
    { clusterId: "c1", refresh: true },
  ]);
  expect(backend.callsTo("metrics_usage")).toHaveLength(4);
  expect(metrics().usageNotServed.c1).toBe(true);
  expect(metrics().usage[PODS]?.error).toBeNull();

  vi.advanceTimersByTime(3 * USAGE_POLL_MS);
  await flush();
  expect(backend.callsTo("metrics_usage")).toHaveLength(4);
  expect(backend.callsTo("metrics_provider")).toHaveLength(2);

  served = true;
  forgetProvider("c1");
  await flush();
  expect(metrics().usageNotServed.c1).toBeUndefined();
  expect(backend.callsTo("metrics_usage")).toHaveLength(6);
  expect(metrics().usage[PODS]?.value?.items).toEqual([WEB]);
  stopPods();
  stopNodes();
});

test("under Prometheus, noMetricsServer marks usage not served without reading the provider again", async () => {
  const backend = mockBackend({
    metrics_provider: () => prometheus(),
    metrics_usage: () => {
      throw NO_METRICS_SERVER;
    },
  });
  ensureProvider("c1");
  await flush();
  await askUsage("c1", "pods", "shop");
  await flush();
  expect(metrics().usageNotServed.c1).toBe(true);
  expect(backend.callsTo("metrics_provider")).toHaveLength(1);
});
