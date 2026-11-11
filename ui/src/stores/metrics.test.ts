import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { MetricsProvider } from "../ipc/generated/MetricsProvider";
import type { MetricsResult } from "../ipc/generated/MetricsResult";
import type { MetricsTarget } from "../ipc/generated/MetricsTarget";
import { flush, mockBackend } from "../test/ipc";
import {
  metricsResult,
  metricsServer,
  NO_PROMETHEUS,
  PROMETHEUS_DOWN,
  points,
  prometheus,
  UNREACHABLE,
} from "../test/metrics";
import { CONNECTED, connectClusters, setClusterState } from "../test/terminal";
import { resetCatalogForTest } from "./catalog";
import {
  askQuery,
  ensureProvider,
  forgetProvider,
  QUERY_STEP_MS,
  queryKey,
  refreshProvider,
  resetMetricsForTest,
  useMetrics,
  watchQuery,
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
const CLUSTER: MetricsTarget = { kind: "cluster" };
const POD: MetricsTarget = { kind: "pod", namespace: "shop", name: "web-1" };
const KEY = queryKey("c1", CLUSTER, "1h");
const RESULT = metricsResult({ cpuUsage: points([0.2, 0.3]) });

function pollTimers(): void {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
}

test("the range and the view start at 1h and Chart, shared by every panel", () => {
  expect(metrics().range).toBe("1h");
  expect(metrics().view).toBe("chart");
  metrics().setRange("6h");
  metrics().setView("table");
  expect(metrics().range).toBe("6h");
  expect(metrics().view).toBe("table");
});

test("queryKey ignores the order of the target's fields and tells clusters, targets and ranges apart", () => {
  const a = queryKey(
    "c1",
    {
      kind: "workload",
      namespace: "shop",
      name: "web",
      workloadKind: "Deployment",
    },
    "1h",
  );
  const b = queryKey(
    "c1",
    {
      workloadKind: "Deployment",
      name: "web",
      namespace: "shop",
      kind: "workload",
    },
    "1h",
  );
  expect(a).toBe(b);
  expect(new Set([a, queryKey("c2", CLUSTER, "1h"), KEY])).toHaveProperty(
    "size",
    3,
  );
  expect(queryKey("c1", CLUSTER, "6h")).not.toBe(KEY);
  expect(queryKey("c1", POD, "1h")).not.toBe(KEY);
});

test("ensureProvider reads once and caches; refreshProvider asks with refresh and shares a read in flight", async () => {
  const backend = mockBackend({ metrics_provider: () => prometheus() });
  ensureProvider("c1");
  ensureProvider("c1");
  await flush();
  expect(backend.callsTo("metrics_provider")).toEqual([
    { clusterId: "c1", refresh: false },
  ]);
  expect(metrics().providers.c1).toEqual({
    value: prometheus(),
    error: null,
    loading: false,
  });

  ensureProvider("c1");
  await flush();
  expect(backend.callsTo("metrics_provider")).toHaveLength(1);

  const first = refreshProvider("c1");
  const again = refreshProvider("c1");
  expect(again).toBe(first);
  await first;
  expect(backend.callsTo("metrics_provider")).toEqual([
    { clusterId: "c1", refresh: false },
    { clusterId: "c1", refresh: true },
  ]);
});

test("a refresh keeps the shown provider until it answers", async () => {
  let answer: (provider: MetricsProvider) => void = () => {};
  let calls = 0;
  mockBackend({
    metrics_provider: () => {
      calls += 1;
      if (calls === 1) return prometheus();
      return new Promise<MetricsProvider>((resolve) => {
        answer = resolve;
      });
    },
  });
  ensureProvider("c1");
  await flush();
  const refreshed = refreshProvider("c1");
  await flush();
  expect(metrics().providers.c1).toEqual({
    value: prometheus(),
    error: null,
    loading: true,
  });
  answer(metricsServer());
  await refreshed;
  expect(metrics().providers.c1?.value).toEqual(metricsServer());
});

test("a failed provider read keeps its error; forgetProvider drops it and the next ensure reads again", async () => {
  let fail = true;
  const backend = mockBackend({
    metrics_provider: () => {
      if (fail) throw PROMETHEUS_DOWN;
      return metricsServer();
    },
  });
  ensureProvider("c1");
  await flush();
  expect(metrics().providers.c1?.value).toBeNull();
  expect(metrics().providers.c1?.error?.code).toBe("Internal");
  expect(metrics().providers.c1?.error?.message).toBe(
    "Prometheus answered 503",
  );

  ensureProvider("c1");
  await flush();
  expect(backend.callsTo("metrics_provider")).toHaveLength(1);

  fail = false;
  forgetProvider("c1");
  expect(metrics().providers.c1).toBeUndefined();
  ensureProvider("c1");
  await flush();
  expect(metrics().providers.c1).toEqual({
    value: metricsServer(),
    error: null,
    loading: false,
  });
});

test("forgetProvider ignores a read still on its way", async () => {
  let answer: (provider: MetricsProvider) => void = () => {};
  mockBackend({
    metrics_provider: () =>
      new Promise<MetricsProvider>((resolve) => {
        answer = resolve;
      }),
  });
  ensureProvider("c1");
  await flush();
  forgetProvider("c1");
  answer(prometheus());
  await flush();
  expect(metrics().providers.c1).toBeUndefined();
});

test("watchers of one key share a poller that asks at once, every step, and stops with the last one", async () => {
  pollTimers();
  const backend = mockBackend({ metrics_query: () => RESULT });
  const stopA = watchQuery("c1", CLUSTER, "1h");
  const stopB = watchQuery("c1", { kind: "cluster" }, "1h");
  await flush();
  expect(backend.callsTo("metrics_query")).toEqual([
    { clusterId: "c1", target: CLUSTER, range: "1h" },
  ]);
  expect(metrics().queries[KEY]).toEqual({
    value: RESULT,
    error: null,
    loading: false,
  });

  vi.advanceTimersByTime(QUERY_STEP_MS["1h"]);
  await flush();
  expect(backend.callsTo("metrics_query")).toHaveLength(2);

  stopA();
  stopA();
  vi.advanceTimersByTime(QUERY_STEP_MS["1h"]);
  await flush();
  expect(backend.callsTo("metrics_query")).toHaveLength(3);

  stopB();
  vi.advanceTimersByTime(QUERY_STEP_MS["1h"]);
  await flush();
  expect(backend.callsTo("metrics_query")).toHaveLength(3);
  expect(metrics().queries[KEY]?.value).toEqual(RESULT);
});

test.each([
  ["1h", 60_000],
  ["6h", 300_000],
  ["24h", 900_000],
  ["7d", 3_600_000],
] as const)("a %s query asks again every %i ms", async (range, step) => {
  pollTimers();
  const backend = mockBackend({ metrics_query: () => RESULT });
  const stop = watchQuery("c1", POD, range);
  await flush();
  expect(QUERY_STEP_MS[range]).toBe(step);
  vi.advanceTimersByTime(step - 1);
  await flush();
  expect(backend.callsTo("metrics_query")).toHaveLength(1);
  vi.advanceTimersByTime(1);
  await flush();
  expect(backend.callsTo("metrics_query")).toEqual([
    { clusterId: "c1", target: POD, range },
    { clusterId: "c1", target: POD, range },
  ]);
  stop();
});

test("no ask while hidden or disconnected; one ask when the window shows again or the cluster reconnects", async () => {
  pollTimers();
  const backend = mockBackend({
    metrics_query: () => RESULT,
    metrics_provider: () => prometheus(),
  });
  const asks = () => backend.callsTo("metrics_query").length;
  ensureProvider("c1");
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("hidden");
  const stop = watchQuery("c1", CLUSTER, "1h");
  await flush();
  expect(asks()).toBe(0);
  vi.advanceTimersByTime(3 * QUERY_STEP_MS["1h"]);
  await flush();
  expect(asks()).toBe(0);

  visibility.mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  await flush();
  expect(asks()).toBe(1);
  // Only a poller that missed a tick asks when the window shows.
  document.dispatchEvent(new Event("visibilitychange"));
  await flush();
  expect(asks()).toBe(1);

  setClusterState("c1", { status: "disconnected" });
  vi.advanceTimersByTime(2 * QUERY_STEP_MS["1h"]);
  await flush();
  expect(asks()).toBe(1);
  expect(metrics().providers.c1?.value).toEqual(prometheus());

  setClusterState("c1", CONNECTED);
  await flush();
  expect(asks()).toBe(2);
  // The reconnect forgets the provider, so the panels read it again.
  expect(metrics().providers.c1).toBeUndefined();

  vi.advanceTimersByTime(QUERY_STEP_MS["1h"]);
  await flush();
  expect(asks()).toBe(3);
  stop();
});

test("an older answer of the same key is dropped", async () => {
  const answers = new Map<string, ((r: MetricsResult) => void)[]>();
  mockBackend({
    metrics_query: (args: { range: string }) =>
      new Promise<MetricsResult>((resolve) => {
        answers.set(args.range, [...(answers.get(args.range) ?? []), resolve]);
      }),
  });
  const first = askQuery("c1", CLUSTER, "1h");
  const second = askQuery("c1", CLUSTER, "1h");
  const other = askQuery("c1", CLUSTER, "6h");
  await flush();
  expect(metrics().queries[KEY]?.loading).toBe(true);

  const NEWER = metricsResult({ cpuUsage: points([0.9]) });
  const SIX_HOURS = metricsResult({ cpuUsage: points([0.5]) }, { step: 300 });
  answers.get("1h")?.[1]?.(NEWER);
  await second;
  answers.get("6h")?.[0]?.(SIX_HOURS);
  await other;
  answers.get("1h")?.[0]?.(RESULT);
  await first;

  expect(metrics().queries[KEY]).toEqual({
    value: NEWER,
    error: null,
    loading: false,
  });
  expect(metrics().queries[queryKey("c1", CLUSTER, "6h")]?.value).toEqual(
    SIX_HOURS,
  );
});

test("a failed ask keeps the last result with the error; the next answer clears it", async () => {
  let fail = false;
  mockBackend({
    metrics_query: () => {
      if (fail) throw PROMETHEUS_DOWN;
      return RESULT;
    },
  });
  await askQuery("c1", CLUSTER, "1h");
  fail = true;
  await askQuery("c1", CLUSTER, "1h");
  const failed = metrics().queries[KEY];
  expect(failed?.value).toEqual(RESULT);
  expect(failed?.loading).toBe(false);
  expect(failed?.error?.code).toBe("Internal");
  expect(failed?.error?.message).toBe("Prometheus answered 503");

  fail = false;
  await askQuery("c1", CLUSTER, "1h");
  expect(metrics().queries[KEY]).toEqual({
    value: RESULT,
    error: null,
    loading: false,
  });
});

test("Unreachable shows no error, and the poller asks again when the cluster reconnects", async () => {
  pollTimers();
  let reachable = false;
  const backend = mockBackend({
    metrics_query: () => {
      if (!reachable) throw UNREACHABLE;
      return RESULT;
    },
  });
  const stop = watchQuery("c1", CLUSTER, "1h");
  await flush();
  expect(metrics().queries[KEY]).toEqual({
    value: null,
    error: null,
    loading: false,
  });

  reachable = true;
  setClusterState("c1", { status: "disconnected" });
  setClusterState("c1", CONNECTED);
  await flush();
  expect(backend.callsTo("metrics_query")).toHaveLength(2);
  expect(metrics().queries[KEY]?.value).toEqual(RESULT);
  stop();
});

test("NotFound noPrometheus reads the provider again once and shows no error", async () => {
  const backend = mockBackend({
    metrics_query: () => {
      throw NO_PROMETHEUS;
    },
    metrics_provider: () => metricsServer(),
  });
  await Promise.all([askQuery("c1", CLUSTER, "1h"), askQuery("c1", POD, "1h")]);
  await flush();
  expect(backend.callsTo("metrics_provider")).toEqual([
    { clusterId: "c1", refresh: true },
  ]);
  expect(metrics().providers.c1?.value).toEqual(metricsServer());
  expect(metrics().queries[KEY]?.error).toBeNull();
  expect(metrics().queries[queryKey("c1", POD, "1h")]?.error).toBeNull();
});
