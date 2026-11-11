import { act, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import type { WatchEvent } from "../../ipc/generated/WatchEvent";
import type { KubeObject } from "../../kinds/objects";
import { DEPLOYMENTS, NODES, PODS } from "../../kinds/refs";
import { resetCatalogForTest } from "../../stores/catalog";
import { resetMetricsForTest } from "../../stores/metrics";
import { resetResourcesForTest } from "../../stores/resources";
import { flush, mockBackend } from "../../test/ipc";
import {
  metricsResult,
  metricsServer,
  points,
  prometheus,
  T0,
  usageItem,
  usageSnapshot,
} from "../../test/metrics";
import { connectClusters } from "../../test/terminal";
import { DrawerMetrics } from "./DrawerMetrics";

const PVCS: ResourceRef = {
  group: "",
  version: "v1",
  plural: "persistentvolumeclaims",
  kind: "PersistentVolumeClaim",
  namespaced: true,
};

const iso = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString();

const RUNNING_POD: KubeObject = {
  metadata: { name: "web", namespace: "shop", labels: { app: "web" } },
  status: {
    phase: "Running",
    startTime: iso(T0 - 7200),
    containerStatuses: [{ name: "main", state: { running: {} } }],
  },
};

function pod(name: string, namespace: string, app: string): KubeObject {
  return {
    metadata: { name, namespace, labels: { app }, resourceVersion: "1" },
  };
}

/** A backend for one panel; `send` delivers a Pod watch event. */
function backend(handlers: Parameters<typeof mockBackend>[0]) {
  let send: (e: WatchEvent) => void = () => {};
  const calls = mockBackend({
    resources_subscribe: (a: {
      onEvent: { onmessage: (e: WatchEvent) => void };
    }) => {
      send = a.onEvent.onmessage;
      return "sub-pods";
    },
    resources_unsubscribe: () => null,
    ...handlers,
  });
  return {
    calls,
    send: async (event: WatchEvent) => {
      await act(async () => {
        send(event);
        await flush();
      });
    },
  };
}

async function show(resource: ResourceRef, object: KubeObject) {
  render(
    <MemoryRouter>
      <DrawerMetrics clusterId="c1" resource={resource} object={object} />
    </MemoryRouter>,
  );
  await act(flush);
  await act(flush);
}

beforeEach(() => {
  resetMetricsForTest();
  resetResourcesForTest();
  resetCatalogForTest();
  connectClusters({ id: "c1", name: "kind" });
});
afterEach(() => {
  resetMetricsForTest();
  resetResourcesForTest();
  resetCatalogForTest();
});

test("a Pod under Prometheus queries its target and shows CPU, Memory, Network and Filesystem", async () => {
  const { calls } = backend({
    metrics_provider: () => prometheus(),
    metrics_query: () =>
      metricsResult({
        cpuUsage: points([0.1, 0.2]),
        memoryUsage: points([2 ** 27, 2 ** 28]),
        networkReceive: points([1024, 2048]),
        networkTransmit: points([512, 512]),
        fsUsage: points([2 ** 20, 2 ** 20]),
      }),
  });
  await show(PODS, RUNNING_POD);
  expect(calls.callsTo("metrics_query")).toEqual([
    {
      clusterId: "c1",
      target: { kind: "pod", namespace: "shop", name: "web" },
      range: "1h",
    },
  ]);
  for (const stem of ["cpu", "memory", "network", "filesystem"]) {
    expect(screen.getByTestId(`metrics-chart-${stem}`)).toBeTruthy();
  }
  expect(screen.queryByTestId("metrics-chart-pods")).toBeNull();
  expect(calls.callsTo("resources_subscribe")).toHaveLength(0);
});

test("a Pending Pod gets its own empty text", async () => {
  backend({
    metrics_provider: () => prometheus(),
    metrics_query: () => metricsResult({}),
  });
  await show(PODS, {
    metadata: { name: "web", namespace: "shop" },
    status: { phase: "Pending" },
  });
  expect(screen.getByTestId("metrics-chart-cpu-empty").textContent).toBe(
    "No samples: web has no running container yet (Pending).",
  );
});

test("a node's subs read its allocatable CPU and memory", async () => {
  const { calls } = backend({
    metrics_provider: () => prometheus(),
    metrics_query: () => metricsResult({ cpuUsage: points([1]) }),
  });
  await show(NODES, {
    metadata: { name: "skopos-e2e-worker" },
    status: { allocatable: { cpu: "4", memory: "16343244Ki" } },
  });
  expect(calls.callsTo("metrics_query")[0]?.target).toEqual({
    kind: "node",
    name: "skopos-e2e-worker",
  });
  expect(
    within(screen.getByTestId("metrics-chart-cpu")).getByText("of 4 cores"),
  ).toBeTruthy();
  expect(
    within(screen.getByTestId("metrics-chart-memory")).getByText("of 15.6 GiB"),
  ).toBeTruthy();
});

test("a workload under metrics-server sums the Pods its selector matches in its namespace", async () => {
  const deployment: KubeObject = {
    metadata: { name: "web", namespace: "shop" },
    spec: { selector: { matchLabels: { app: "web" } } },
    status: { replicas: 2 },
  };
  const b = backend({
    metrics_provider: () => metricsServer(),
    metrics_usage: () =>
      usageSnapshot([
        usageItem({ name: "web-1", cpuCores: 0.25 }),
        usageItem({ name: "web-2", cpuCores: 0.5 }),
        usageItem({ name: "api-1", cpuCores: 1 }),
      ]),
  });
  await show(DEPLOYMENTS, deployment);
  await b.send({
    type: "snapshot",
    items: [
      pod("web-1", "shop", "web"),
      pod("web-2", "shop", "web"),
      pod("api-1", "shop", "api"),
      pod("web-9", "team-b", "web"),
    ],
  } as WatchEvent);
  await act(flush);

  expect(b.calls.callsTo("metrics_usage")).toEqual([
    { clusterId: "c1", of: "pods", namespace: "shop" },
  ]);
  expect(b.calls.callsTo("metrics_query")).toHaveLength(0);
  const cpu = screen.getByTestId("metrics-chart-cpu");
  expect(within(cpu).getByText("2 Pods")).toBeTruthy();
  expect(screen.getByTestId("metrics-chart-cpu-now").textContent).toBe("750m");
});

test("a workload under metrics-server with no matching Pod says it has none", async () => {
  const b = backend({
    metrics_provider: () => metricsServer(),
    metrics_usage: () => usageSnapshot([]),
  });
  await show(DEPLOYMENTS, {
    metadata: { name: "web", namespace: "shop" },
    spec: { selector: { matchLabels: { app: "web" } } },
    status: {},
  });
  await b.send({ type: "snapshot", items: [] } as WatchEvent);
  await act(flush);
  expect(screen.getByTestId("metrics-chart-cpu-empty").textContent).toBe(
    "No samples: web has no Pods.",
  );
});

test("a PVC under metrics-server shows only its note and reads nothing", async () => {
  const { calls } = backend({ metrics_provider: () => metricsServer() });
  await show(PVCS, {
    metadata: { name: "data", namespace: "shop" },
    status: { phase: "Bound", capacity: { storage: "10Gi" } },
  });
  expect(screen.getByTestId("metrics-note").textContent).toBe(
    "Volume usage needs Prometheus: kubelet exports it as kubelet_volume_stats_used_bytes, which metrics-server does not serve.",
  );
  expect(screen.queryByTestId("metrics-toolbar")).toBeNull();
  expect(calls.callsTo("metrics_usage")).toHaveLength(0);
  expect(calls.callsTo("metrics_query")).toHaveLength(0);
});

test("a PVC under Prometheus shows Volume usage with its capacity", async () => {
  backend({
    metrics_provider: () => prometheus(),
    metrics_query: () =>
      metricsResult({
        diskUsage: points([2 ** 30]),
        diskCapacity: points([10 * 2 ** 30]),
      }),
  });
  await show(PVCS, {
    metadata: { name: "data", namespace: "shop" },
    status: { phase: "Bound", capacity: { storage: "10Gi" } },
  });
  expect(
    within(screen.getByTestId("metrics-chart-volume")).getByText(
      "capacity 10 GiB",
    ),
  ).toBeTruthy();
});
