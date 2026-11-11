import { act, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, test } from "vitest";
import type { ClusterInfo } from "../../ipc/generated/ClusterInfo";
import type { MetricsProvider } from "../../ipc/generated/MetricsProvider";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import type { WatchEvent } from "../../ipc/generated/WatchEvent";
import { resetCatalogForTest } from "../../stores/catalog";
import { resetMetricsForTest } from "../../stores/metrics";
import { resetResourcesForTest } from "../../stores/resources";
import { flush, mockBackend } from "../../test/ipc";
import {
  metricsResult,
  metricsServer,
  noProvider,
  points,
  prometheus,
  usageItem,
  usageSnapshot,
} from "../../test/metrics";
import { connectClusters } from "../../test/terminal";
import { OverviewMetrics } from "./OverviewMetrics";

const GIB = 2 ** 30;

const INFO: ClusterInfo = {
  version: "v1.33.1",
  distribution: "kind",
  nodeCount: 2,
  namespaces: ["default", "shop"],
  namespacesRestricted: false,
  isAdmin: true,
};

async function settle() {
  await act(flush);
  await act(flush);
  await act(flush);
}

async function show(handlers: Parameters<typeof mockBackend>[0]) {
  const backend = mockBackend(handlers);
  render(
    <MemoryRouter initialEntries={["/cluster/c1"]}>
      <OverviewMetrics clusterId="c1" clusterName="kind-dev" info={INFO} />
    </MemoryRouter>,
  );
  await settle();
  return backend;
}

const text = (id: string) => screen.getByTestId(id).textContent;

function node(name: string, cpu: string, memory: string) {
  return {
    apiVersion: "v1",
    kind: "Node",
    metadata: { name, uid: name, resourceVersion: "1" },
    status: { allocatable: { cpu, memory } },
  };
}

beforeEach(() => {
  resetMetricsForTest();
  resetResourcesForTest();
  resetCatalogForTest();
  connectClusters({ id: "c1", name: "kind-dev" });
});

test("Prometheus: the gauges read the last usage against the allocatable, from the query the panel shares", async () => {
  const backend = await show({
    metrics_provider: () => prometheus(),
    metrics_query: () =>
      metricsResult({
        cpuUsage: points([1, 1.5]),
        cpuAllocatable: points([4, 4]),
        memoryUsage: points([2 * GIB, 3 * GIB]),
        memoryAllocatable: points([16 * GIB, 16 * GIB]),
      }),
  });

  const cpu = screen.getByTestId("overview-gauge-cpu");
  expect(cpu.getAttribute("aria-label")).toBe("CPU");
  expect(cpu.getAttribute("aria-valuenow")).toBe("38");
  expect(text("overview-gauge-cpu-caption")).toBe(
    "1.5 of 4 cores · Prometheus",
  );
  const memory = screen.getByTestId("overview-gauge-memory");
  expect(memory.getAttribute("aria-label")).toBe("Memory");
  expect(memory.getAttribute("aria-valuenow")).toBe("19");
  expect(text("overview-gauge-memory-caption")).toBe(
    "3 of 16 GiB · Prometheus",
  );

  expect(backend.callsTo("metrics_query")).toEqual([
    { clusterId: "c1", target: { kind: "cluster" }, range: "1h" },
  ]);
  const section = screen.getByTestId("overview-metrics");
  expect(section.querySelector("h2")?.textContent).toBe("Metrics");
  expect(
    within(screen.getByTestId("metrics-chart-cpu")).getByText(
      "of 4 cores on 2 nodes",
    ),
  ).toBeTruthy();
});

test("Prometheus without usage or allocatable: no value and No data", async () => {
  await show({
    metrics_provider: () => prometheus(),
    metrics_query: () =>
      metricsResult(
        { cpuUsage: points([1]) },
        { missing: ["cpuAllocatable", "memoryUsage", "memoryAllocatable"] },
      ),
  });
  for (const id of ["cpu", "memory"]) {
    const bar = screen.getByTestId(`overview-gauge-${id}`);
    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
    expect(text(`overview-gauge-${id}-caption`)).toBe("No data");
  }
});

test("metrics-server: the node snapshot's sum against the Node watch's allocatable", async () => {
  const subs = new Map<string, (event: WatchEvent) => void>();
  const backend = await show({
    metrics_provider: () => metricsServer(),
    metrics_usage: () =>
      usageSnapshot([
        usageItem({
          namespace: null,
          name: "node-a",
          cpuCores: 0.5,
          memoryBytes: 2 * GIB,
        }),
        usageItem({
          namespace: null,
          name: "node-b",
          cpuCores: 0.3,
          memoryBytes: GIB,
        }),
      ]),
    resources_subscribe: (a: {
      resource: ResourceRef;
      onEvent: { onmessage: (event: WatchEvent) => void };
    }) => {
      subs.set(a.resource.plural, a.onEvent.onmessage);
      return `sub-${a.resource.plural}`;
    },
    resources_unsubscribe: () => null,
  });
  // Before the Node watch answers there is no allocatable.
  expect(text("overview-gauge-cpu-caption")).toBe("No data");

  await act(async () => {
    subs.get("nodes")?.({
      type: "snapshot",
      items: [node("node-a", "2", "8Gi"), node("node-b", "1", "4Gi")],
    });
    await flush();
  });

  expect(
    screen.getByTestId("overview-gauge-cpu").getAttribute("aria-valuenow"),
  ).toBe("27");
  expect(text("overview-gauge-cpu-caption")).toBe(
    "0.8 of 3 cores · metrics-server",
  );
  expect(
    screen.getByTestId("overview-gauge-memory").getAttribute("aria-valuenow"),
  ).toBe("25");
  expect(text("overview-gauge-memory-caption")).toBe(
    "3 of 12 GiB · metrics-server",
  );
  // One poller serves the gauges and the panel.
  expect(backend.callsTo("metrics_usage")).toEqual([
    { clusterId: "c1", of: "nodes", namespace: null },
  ]);
  expect(backend.callsTo("resources_subscribe")).toHaveLength(1);
  expect(
    within(screen.getByTestId("metrics-chart-cpu")).getByText(
      "of 3 cores on 2 nodes",
    ),
  ).toBeTruthy();
});

test("provider None: no gauges, only the note", async () => {
  const backend = await show({
    metrics_provider: () => noProvider("nothingFound"),
  });
  expect(screen.queryByTestId("overview-gauges")).toBeNull();
  expect(screen.getByTestId("metrics-note").textContent).toContain(
    "No metrics provider answers in kind-dev",
  );
  expect(screen.queryByTestId("metrics-toolbar")).toBeNull();
  expect(backend.callsTo("metrics_query")).toEqual([]);
  expect(backend.callsTo("metrics_usage")).toEqual([]);
});

test("no gauges while the provider is checked", async () => {
  await show({
    metrics_provider: () => new Promise<MetricsProvider>(() => {}),
  });
  expect(screen.queryByTestId("overview-gauges")).toBeNull();
  expect(
    screen.getByRole("status", { name: "Checking the metrics provider" }),
  ).toBeTruthy();
});
