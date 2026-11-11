import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, expect, test } from "vitest";
import type { IpcError } from "../../ipc/generated/IpcError";
import type { MetricsProvider } from "../../ipc/generated/MetricsProvider";
import type { MetricsRange } from "../../ipc/generated/MetricsRange";
import type { MetricsResult } from "../../ipc/generated/MetricsResult";
import type { MetricsTarget } from "../../ipc/generated/MetricsTarget";
import { resetCatalogForTest } from "../../stores/catalog";
import { askQuery, resetMetricsForTest } from "../../stores/metrics";
import { flush, mockBackend } from "../../test/ipc";
import {
  FORBIDDEN,
  metricsResult,
  metricsServer,
  noProvider,
  PROMETHEUS_DOWN,
  points,
  prometheus,
  T0,
  usageItem,
  usageSnapshot,
} from "../../test/metrics";
import { connectClusters } from "../../test/terminal";
import { NO_FACTS } from "./charts";
import {
  MetricsPanel,
  type MetricsPanelProps,
  type UsageSource,
} from "./MetricsPanel";

const CLUSTER: MetricsTarget = { kind: "cluster" };
const POD: MetricsTarget = { kind: "pod", namespace: "shop", name: "web-1" };
const PVC: MetricsTarget = { kind: "pvc", namespace: "shop", name: "data" };
const NODE_USAGE: UsageSource = { of: "nodes", namespace: null, keys: null };
const POD_USAGE: UsageSource = {
  of: "pods",
  namespace: "shop",
  keys: ["shop/web-1"],
};
const GIB = 2 ** 30;

const USAGE_DOWN: IpcError = {
  code: "Internal",
  message: "the metrics API answered 503",
  details: null,
};

const RESULT = metricsResult({
  cpuUsage: points([1.2, 1.5]),
  cpuRequests: points([2, 2]),
  cpuLimits: points([3, 3]),
  cpuAllocatable: points([4, 4]),
  memoryUsage: points([2 * GIB, 3 * GIB]),
  memoryRequests: points([4 * GIB, 4 * GIB]),
  memoryLimits: points([6 * GIB, 6 * GIB]),
  memoryAllocatable: points([16 * GIB, 16 * GIB]),
  podUsage: points([20, 21]),
  podCapacity: points([220, 220]),
  diskUsage: points([30 * GIB, 31 * GIB]),
  diskCapacity: points([100 * GIB, 100 * GIB]),
});

function Location() {
  const { pathname } = useLocation();
  return <span data-testid="location">{pathname}</span>;
}

/** Lets the provider answer, the watches start and their answers render. */
async function settle() {
  await act(flush);
  await act(flush);
  await act(flush);
}

async function show(
  handlers: Parameters<typeof mockBackend>[0],
  over: Partial<MetricsPanelProps> = {},
) {
  const backend = mockBackend(handlers);
  render(
    <MemoryRouter initialEntries={["/cluster/c1"]}>
      <MetricsPanel
        clusterId="c1"
        clusterName="kind-dev"
        target={CLUSTER}
        facts={{ ...NO_FACTS, nodeCount: 2 }}
        usage={NODE_USAGE}
        layout="grid"
        {...over}
      />
      <Location />
    </MemoryRouter>,
  );
  await settle();
  return backend;
}

const text = (id: string) => screen.getByTestId(id).textContent;

beforeEach(() => {
  resetMetricsForTest();
  resetCatalogForTest();
  connectClusters({ id: "c1", name: "kind-dev" });
});

test("a spinner shows while the provider is checked", async () => {
  let answer: (p: MetricsProvider) => void = () => {};
  await show({
    metrics_provider: () =>
      new Promise<MetricsProvider>((resolve) => {
        answer = resolve;
      }),
  });
  expect(
    screen.getByRole("status", { name: "Checking the metrics provider" }),
  ).toBeTruthy();

  await act(async () => {
    answer(noProvider("setting"));
    await flush();
  });
  expect(
    screen.queryByRole("status", { name: "Checking the metrics provider" }),
  ).toBeNull();
  expect(screen.getByTestId("metrics-note")).toBeTruthy();
});

test("provider None from the settings: only the note, whose button opens the cluster settings", async () => {
  await show({ metrics_provider: () => noProvider("setting") });
  const note = screen.getByTestId("metrics-note");
  expect(note.getAttribute("role")).toBe("note");
  expect(note.querySelector("p")?.textContent).toBe(
    "Metrics are off: the metrics provider is None in the cluster settings.",
  );
  expect(screen.queryByTestId("metrics-toolbar")).toBeNull();
  expect(screen.queryByTestId("metrics-grid")).toBeNull();

  expect(text("metrics-note-action")).toBe("Cluster settings");
  fireEvent.click(screen.getByTestId("metrics-note-action"));
  expect(text("location")).toBe("/cluster/c1/settings");
});

test("no provider found: the note names the cluster and leads to the Helm charts", async () => {
  await show({ metrics_provider: () => noProvider("nothingFound") });
  expect(
    screen.getByTestId("metrics-note").querySelector("p")?.textContent,
  ).toBe(
    "No metrics provider answers in kind-dev: there is no Prometheus Service and the metrics.k8s.io API is not served. Install metrics-server or kube-prometheus-stack from the Helm charts.",
  );
  expect(screen.queryByTestId("metrics-toolbar")).toBeNull();

  expect(text("metrics-note-action")).toBe("Helm charts");
  fireEvent.click(screen.getByTestId("metrics-note-action"));
  expect(text("location")).toBe("/cluster/c1/helm/charts");
});

test("a failed provider check shows its error block, and Retry checks again with refresh", async () => {
  let fail = true;
  const backend = await show({
    metrics_provider: () => {
      if (fail) throw PROMETHEUS_DOWN;
      return prometheus();
    },
    metrics_query: () => RESULT,
  });
  const block = screen.getByTestId("metrics-error");
  expect(block.getAttribute("role")).toBe("alert");
  expect(block.querySelector("strong")?.textContent).toBe(
    "Metrics could not be checked",
  );
  expect(block.textContent).toContain("Prometheus answered 503");

  fail = false;
  fireEvent.click(screen.getByTestId("metrics-retry"));
  await settle();

  expect(backend.callsTo("metrics_provider")).toEqual([
    { clusterId: "c1", refresh: false },
    { clusterId: "c1", refresh: true },
  ]);
  expect(screen.queryByTestId("metrics-error")).toBeNull();
  expect(screen.getByTestId("metrics-toolbar")).toBeTruthy();
});

test.each([
  [
    prometheus(),
    "Prometheus monitoring/prometheus-server:80, autodetected, through the API server proxy",
  ],
  [
    prometheus({ chosenBy: "setting" }),
    "Prometheus monitoring/prometheus-server:80, pinned in the cluster settings, through the API server proxy",
  ],
  [
    metricsServer("fallback"),
    "metrics-server, autodetected: no Prometheus Service found. Samples every 15 s while the cluster is connected",
  ],
  [
    metricsServer("setting"),
    "metrics-server, set in the cluster settings. Samples every 15 s while the cluster is connected",
  ],
])(
  "the source line says where metrics come from and how it was chosen (%#)",
  async (provider, line) => {
    await show({
      metrics_provider: () => provider,
      metrics_query: () => RESULT,
      metrics_usage: () => usageSnapshot([]),
    });
    expect(text("metrics-source")).toBe(line);
  },
);

test("Prometheus: the range and view pickers, the four cluster charts, and 6h asks for 6h", async () => {
  const backend = await show({
    metrics_provider: () => prometheus(),
    metrics_query: () => RESULT,
  });
  expect(screen.getByTestId("metrics-range")).toBeTruthy();
  expect(screen.getByTestId("metrics-view")).toBeTruthy();
  expect(screen.queryByTestId("metrics-live")).toBeNull();
  expect(screen.queryByTestId("metrics-note")).toBeNull();
  for (const stem of ["cpu", "memory", "pods", "disk"]) {
    expect(screen.getByTestId(`metrics-chart-${stem}`)).toBeTruthy();
  }
  expect(
    within(screen.getByTestId("metrics-chart-cpu")).getByText(
      "of 4 cores on 2 nodes",
    ),
  ).toBeTruthy();
  expect(
    within(screen.getByTestId("metrics-chart-memory")).getByText(
      "of 16 GiB on 2 nodes",
    ),
  ).toBeTruthy();
  expect(
    within(screen.getByTestId("metrics-chart-pods")).getByText(
      "running, capacity 220",
    ),
  ).toBeTruthy();
  expect(text("metrics-chart-cpu-now")).toBe("1.5 cores");
  expect(screen.getByTestId("metrics-grid").classList.contains("grid")).toBe(
    true,
  );

  fireEvent.click(screen.getByRole("radio", { name: "6h" }));
  await settle();
  expect(backend.callsTo("metrics_query")).toContainEqual({
    clusterId: "c1",
    target: { kind: "cluster" },
    range: "6h",
  });
});

test("Prometheus: Loading ‹range› and no grid before the first answer", async () => {
  const pending: ((r: MetricsResult) => void)[] = [];
  await show({
    metrics_provider: () => prometheus(),
    metrics_query: () =>
      new Promise<MetricsResult>((resolve) => {
        pending.push(resolve);
      }),
  });
  expect(text("metrics-loading")).toBe("Loading 1h");
  expect(screen.queryByTestId("metrics-grid")).toBeNull();

  await act(async () => {
    pending[0]?.(RESULT);
    await flush();
  });
  expect(screen.queryByTestId("metrics-loading")).toBeNull();
  expect(screen.getByTestId("metrics-grid").classList.contains("dim")).toBe(
    false,
  );
});

test("a new range keeps the last charts, dimmed, with Loading ‹range› until its first answer", async () => {
  const pending: ((r: MetricsResult) => void)[] = [];
  await show({
    metrics_provider: () => prometheus(),
    metrics_query: (a: { range: MetricsRange }) =>
      a.range === "1h"
        ? RESULT
        : new Promise<MetricsResult>((resolve) => {
            pending.push(resolve);
          }),
  });
  fireEvent.click(screen.getByRole("radio", { name: "6h" }));
  await settle();

  expect(text("metrics-loading")).toBe("Loading 6h");
  expect(screen.getByTestId("metrics-grid").classList.contains("dim")).toBe(
    true,
  );
  expect(text("metrics-chart-cpu-now")).toBe("1.5 cores");

  await act(async () => {
    pending[0]?.(
      metricsResult({ cpuUsage: points([0.5]) }, { end: T0 + 6 * 3600 }),
    );
    await flush();
  });
  expect(screen.queryByTestId("metrics-loading")).toBeNull();
  expect(screen.getByTestId("metrics-grid").classList.contains("dim")).toBe(
    false,
  );
  expect(text("metrics-chart-cpu-now")).toBe("500m");
});

test("a failed query keeps the last charts dimmed under the error block; Retry waits for its answer and the block goes", async () => {
  let answer: () => unknown = () => RESULT;
  const backend = await show({
    metrics_provider: () => prometheus(),
    metrics_query: () => answer(),
  });
  answer = () => {
    throw PROMETHEUS_DOWN;
  };
  await act(() => askQuery("c1", CLUSTER, "1h"));

  const block = screen.getByTestId("metrics-error");
  expect(block.getAttribute("role")).toBe("alert");
  expect(block.querySelector("strong")?.textContent).toBe(
    "Prometheus did not answer",
  );
  expect(block.textContent).toContain("Prometheus answered 503");
  expect(text("metrics-chart-cpu-now")).toBe("1.5 cores");
  expect(screen.getByTestId("metrics-grid").classList.contains("dim")).toBe(
    true,
  );

  let release: (r: MetricsResult) => void = () => {};
  answer = () =>
    new Promise<MetricsResult>((resolve) => {
      release = resolve;
    });
  fireEvent.click(screen.getByTestId("metrics-retry"));
  await act(flush);
  expect(
    (screen.getByTestId("metrics-retry") as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(text("metrics-loading")).toBe("Retrying");

  await act(async () => {
    release(RESULT);
    await flush();
  });
  expect(screen.queryByTestId("metrics-error")).toBeNull();
  expect(backend.callsTo("metrics_query")).toHaveLength(3);
  expect(screen.getByTestId("metrics-grid").classList.contains("dim")).toBe(
    false,
  );
});

test("the error block's Cluster settings opens the settings", async () => {
  await show({
    metrics_provider: () => prometheus(),
    metrics_query: () => {
      throw PROMETHEUS_DOWN;
    },
  });
  fireEvent.click(screen.getByTestId("metrics-settings"));
  expect(text("location")).toBe("/cluster/c1/settings");
});

test("a missing main series shows the empty text and a missing reference line is left out", async () => {
  await show({
    metrics_provider: () => prometheus(),
    metrics_query: () =>
      metricsResult(
        {
          cpuRequests: points([2, 2]),
          memoryUsage: points([2 * GIB, 3 * GIB]),
          memoryRequests: points([4 * GIB, 4 * GIB]),
          podUsage: points([20, 21]),
          podCapacity: [],
        },
        { missing: ["cpuUsage", "memoryLimits"] },
      ),
  });

  expect(text("metrics-chart-cpu-empty")).toBe("No samples in this range.");
  expect(text("metrics-chart-cpu-now")).toBe("—");

  const memory = screen.getByTestId("metrics-chart-memory");
  expect(screen.queryByTestId("metrics-chart-memory-empty")).toBeNull();
  expect(within(memory).queryByText("Requests")).not.toBeNull();
  expect(within(memory).queryByText("Limits")).toBeNull();

  const pods = screen.getByTestId("metrics-chart-pods");
  expect(screen.queryByTestId("metrics-chart-pods-empty")).toBeNull();
  expect(within(pods).queryByText("Capacity")).toBeNull();
});

test("the view picker shows tables", async () => {
  await show({
    metrics_provider: () => prometheus(),
    metrics_query: () => RESULT,
  });
  fireEvent.click(screen.getByRole("radio", { name: "Table" }));
  await settle();
  expect(screen.getByTestId("metrics-table-cpu")).toBeTruthy();
});

test("the drawer's layout is one column", async () => {
  await show(
    { metrics_provider: () => prometheus(), metrics_query: () => RESULT },
    { layout: "column" },
  );
  expect(screen.getByTestId("metrics-grid").classList.contains("column")).toBe(
    true,
  );
});

test("the object's empty text replaces the shared one", async () => {
  const seen: [string, number | null][] = [];
  const objectEmpty = (source: string, start: number | null) => {
    seen.push([source, start]);
    return `object text for ${source}`;
  };
  await show(
    {
      metrics_provider: () => prometheus(),
      metrics_query: () => metricsResult({}),
    },
    { objectEmpty },
  );
  expect(text("metrics-chart-cpu-empty")).toBe("object text for prometheus");
  expect(seen).toContainEqual(["prometheus", T0]);
});

test("metrics-server: the Live badge and text, no range picker, and rolling CPU and Memory under the note", async () => {
  const backend = await show({
    metrics_provider: () => metricsServer(),
    metrics_usage: () =>
      usageSnapshot([
        usageItem({
          namespace: null,
          name: "node-a",
          cpuCores: 0.5,
          memoryBytes: GIB,
        }),
        usageItem({
          namespace: null,
          name: "node-b",
          cpuCores: 0.25,
          memoryBytes: GIB,
        }),
      ]),
  });
  expect(backend.callsTo("metrics_usage")).toEqual([
    { clusterId: "c1", of: "nodes", namespace: null },
  ]);
  expect(text("metrics-live-badge")).toBe("Live");
  expect(text("metrics-live")).toBe("Last 1 min, 1 sample");
  expect(screen.queryByTestId("metrics-range")).toBeNull();
  expect(screen.queryByTestId("metrics-loading")).toBeNull();
  expect(text("metrics-note")).toBe(
    "Pods and disk history need Prometheus: metrics-server reports only the current CPU and memory.",
  );
  expect(text("metrics-chart-cpu-now")).toBe("750m");
  expect(text("metrics-chart-memory-now")).toBe("2 GiB");
  expect(screen.queryByTestId("metrics-chart-pods")).toBeNull();
  expect(screen.queryByTestId("metrics-chart-disk")).toBeNull();
});

test("metrics-server before the first sample: waiting, the collecting text, and never Loading", async () => {
  await show({
    metrics_provider: () => metricsServer(),
    metrics_usage: () => new Promise(() => {}),
  });
  expect(text("metrics-live")).toBe("Waiting for the first sample");
  expect(screen.queryByTestId("metrics-loading")).toBeNull();
  expect(text("metrics-chart-cpu-empty")).toBe(
    "Collecting samples: metrics-server is read every 15 s, the next sample arrives in 15 s.",
  );
});

test("metrics-server for a Pod: its note and only its own samples", async () => {
  const backend = await show(
    {
      metrics_provider: () => metricsServer(),
      metrics_usage: () =>
        usageSnapshot([
          usageItem({ name: "web-1", cpuCores: 0.25 }),
          usageItem({ name: "web-2", cpuCores: 0.5 }),
        ]),
    },
    { target: POD, usage: POD_USAGE, layout: "column" },
  );
  expect(backend.callsTo("metrics_usage")).toEqual([
    { clusterId: "c1", of: "pods", namespace: "shop" },
  ]);
  expect(text("metrics-note")).toBe(
    "Network and filesystem charts need Prometheus: metrics-server reports only the current CPU and memory.",
  );
  expect(text("metrics-chart-cpu-now")).toBe("250m");
  expect(screen.queryByTestId("metrics-chart-network")).toBeNull();
});

test("metrics-server for a PVC: only its note, and no snapshot is read", async () => {
  const backend = await show(
    { metrics_provider: () => metricsServer() },
    { target: PVC, usage: null, layout: "column" },
  );
  expect(text("metrics-note")).toBe(
    "Volume usage needs Prometheus: kubelet exports it as kubelet_volume_stats_used_bytes, which metrics-server does not serve.",
  );
  expect(screen.queryByTestId("metrics-toolbar")).toBeNull();
  expect(backend.callsTo("metrics_usage")).toEqual([]);
});

test("metrics-server: a forbidden node snapshot shows the forbidden note in place of the error block and charts", async () => {
  await show({
    metrics_provider: () => metricsServer(),
    metrics_usage: () => {
      throw FORBIDDEN;
    },
  });
  expect(text("metrics-note")).toBe(
    "Metrics are not shown: the nodes API is forbidden, so usage cannot be summed.",
  );
  expect(screen.queryByTestId("metrics-error")).toBeNull();
  expect(screen.queryByTestId("metrics-grid")).toBeNull();
  expect(screen.getByTestId("metrics-toolbar")).toBeTruthy();
});

test("metrics-server: a failed snapshot shows its error block, and Retry asks again", async () => {
  let fail = true;
  const backend = await show(
    {
      metrics_provider: () => metricsServer(),
      metrics_usage: () => {
        if (fail) throw USAGE_DOWN;
        return usageSnapshot([usageItem({ name: "web-1" })]);
      },
    },
    { target: POD, usage: POD_USAGE },
  );
  const block = screen.getByTestId("metrics-error");
  expect(block.querySelector("strong")?.textContent).toBe(
    "metrics.k8s.io did not answer",
  );
  expect(block.textContent).toContain("the metrics API answered 503");

  fail = false;
  fireEvent.click(screen.getByTestId("metrics-retry"));
  await settle();
  expect(backend.callsTo("metrics_usage")).toHaveLength(2);
  expect(screen.queryByTestId("metrics-error")).toBeNull();
  expect(text("metrics-chart-cpu-now")).toBe("250m");
});
