import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import type { WatchEvent } from "../../ipc/generated/WatchEvent";
import "../../kinds";
import type { KubeObject } from "../../kinds/objects";
import { DEPLOYMENTS, NODES, PODS } from "../../kinds/refs";
import { resetCatalogForTest } from "../../stores/catalog";
import { resetMetricsForTest } from "../../stores/metrics";
import { resetResourcesForTest } from "../../stores/resources";
import { flush, mockBackend } from "../../test/ipc";
import {
  NO_METRICS_SERVER,
  noProvider,
  prometheus,
  usageItem,
  usageSnapshot,
} from "../../test/metrics";
import { mockElementSize } from "../../test/size";
import { connectClusters, setClusterState } from "../../test/terminal";
import { ResourceScreen } from "../resources/ResourceScreen";
import { useListUsage } from "./useListUsage";

function Probe(props: { resource: ResourceRef | null; namespaces?: string[] }) {
  const view = useListUsage("c1", props.resource, props.namespaces ?? []);
  const shown = view && {
    keys: view.items ? [...view.items.keys()] : null,
    notServed: view.notServed,
  };
  return <output data-testid="view">{JSON.stringify(shown ?? null)}</output>;
}

const shown = () => JSON.parse(screen.getByTestId("view").textContent ?? "");

async function probe(resource: ResourceRef | null, namespaces?: string[]) {
  render(<Probe resource={resource} namespaces={namespaces} />);
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
  vi.restoreAllMocks();
});

test("a Pods list with no namespace filter reads usage across the cluster", async () => {
  const backend = mockBackend({
    metrics_provider: () => prometheus(),
    metrics_usage: () => usageSnapshot([usageItem({ name: "web" })]),
  });
  await probe(PODS);
  expect(backend.callsTo("metrics_usage")).toEqual([
    { clusterId: "c1", of: "pods", namespace: null },
  ]);
  expect(shown()).toEqual({ keys: ["shop/web"], notServed: false });
});

test("a Pods list filtered to namespaces reads each of them", async () => {
  const backend = mockBackend({
    metrics_provider: () => prometheus(),
    metrics_usage: (a: { namespace: string }) =>
      usageSnapshot([usageItem({ name: "web", namespace: a.namespace })]),
  });
  await probe(PODS, ["shop", "team-a"]);
  expect(backend.callsTo("metrics_usage")).toEqual([
    { clusterId: "c1", of: "pods", namespace: "shop" },
    { clusterId: "c1", of: "pods", namespace: "team-a" },
  ]);
  expect(shown()).toEqual({
    keys: ["shop/web", "team-a/web"],
    notServed: false,
  });
});

test("restricted namespaces read each namespace the cluster allows", async () => {
  setClusterState("c1", {
    status: "connected",
    info: {
      version: "v1.33.1",
      distribution: "kind",
      nodeCount: 2,
      namespaces: ["skopos-test-a", "skopos-test-b"],
      namespacesRestricted: true,
      isAdmin: false,
    },
  });
  const backend = mockBackend({
    metrics_provider: () => prometheus(),
    metrics_usage: () => usageSnapshot([]),
  });
  await probe(PODS);
  expect(backend.callsTo("metrics_usage").map((a) => a.namespace)).toEqual([
    "skopos-test-a",
    "skopos-test-b",
  ]);
});

test("a Nodes list reads nodes once and keys them by name", async () => {
  const backend = mockBackend({
    metrics_provider: () => prometheus(),
    metrics_usage: () =>
      usageSnapshot([
        usageItem({ name: "skopos-e2e-worker", namespace: null }),
      ]),
  });
  await probe(NODES, ["shop"]);
  expect(backend.callsTo("metrics_usage")).toEqual([
    { clusterId: "c1", of: "nodes", namespace: null },
  ]);
  expect(shown()).toEqual({ keys: ["skopos-e2e-worker"], notServed: false });
});

test("provider none reads nothing, so every cell reads —", async () => {
  const backend = mockBackend({
    metrics_provider: () => noProvider("setting"),
  });
  await probe(PODS);
  expect(backend.callsTo("metrics_provider")).toHaveLength(1);
  expect(backend.callsTo("metrics_usage")).toHaveLength(0);
  expect(shown()).toEqual({ keys: null, notServed: false });
});

test("noMetricsServer marks the list not served", async () => {
  mockBackend({
    metrics_provider: () => prometheus(),
    metrics_usage: () => {
      throw NO_METRICS_SERVER;
    },
  });
  await probe(PODS);
  expect(shown()).toEqual({ keys: [], notServed: true });
});

test("other lists get no usage and read nothing", async () => {
  const backend = mockBackend({});
  await probe(DEPLOYMENTS);
  expect(shown()).toBeNull();
  expect(backend.calls.filter((c) => c.cmd.startsWith("metrics_"))).toEqual([]);
});

test("a Pods list of a cluster that is not connected reads nothing", async () => {
  setClusterState("c1", { status: "disconnected" });
  const backend = mockBackend({});
  await probe(PODS);
  expect(shown()).toEqual({ keys: null, notServed: false });
  expect(backend.calls.filter((c) => c.cmd.startsWith("metrics_"))).toEqual([]);
});

const PODS_INFO: ApiResourceInfo = {
  resource: PODS,
  verbs: ["list", "watch"],
  shortNames: [],
  canList: true,
  canWatch: true,
  canCreate: true,
  canUpdate: true,
  canPatch: true,
  canDelete: true,
};

function pod(name: string): KubeObject {
  return { metadata: { name, namespace: "shop", resourceVersion: "1" } };
}

test("the Pods table shows CPU and Memory, and sorts a — last both ways", async () => {
  mockElementSize();
  let send: (e: WatchEvent) => void = () => {};
  mockBackend({
    ui_state_get: () => null,
    ui_state_set: () => null,
    resources_subscribe: (a: {
      onEvent: { onmessage: (e: WatchEvent) => void };
    }) => {
      send = a.onEvent.onmessage;
      return "sub-pods";
    },
    resources_unsubscribe: () => null,
    metrics_provider: () => prometheus(),
    metrics_usage: () =>
      usageSnapshot([
        usageItem({ name: "web", cpuCores: 0.25, memoryBytes: 64 * 2 ** 20 }),
        usageItem({ name: "api", cpuCores: 1.25, memoryBytes: 2 ** 30 }),
      ]),
  });
  render(
    <MemoryRouter>
      <ResourceScreen clusterId="c1" info={PODS_INFO} resources={[PODS_INFO]} />
    </MemoryRouter>,
  );
  await act(flush);
  await act(async () => {
    send({
      type: "snapshot",
      items: [pod("idle"), pod("web"), pod("api")],
    } as WatchEvent);
    await flush();
  });
  await act(flush);
  await act(flush);

  const cell = (name: string, id: string) =>
    within(screen.getByTestId(`resource-row-shop-${name}`)).getByTestId(id)
      .textContent;
  expect(cell("web", "usage-cpu")).toBe("250m");
  expect(cell("web", "usage-memory")).toBe("64Mi");
  expect(cell("api", "usage-memory")).toBe("1.0Gi");
  expect(cell("idle", "usage-cpu")).toBe("—");

  const order = () =>
    screen
      .getAllByTestId(/^resource-row-/)
      .map((row) => row.dataset.testid?.replace("resource-row-shop-", ""));
  const sortByCpu = screen.getByRole("button", { name: /CPU/ });
  fireEvent.click(sortByCpu);
  expect(order()).toEqual(["web", "api", "idle"]);
  fireEvent.click(sortByCpu);
  expect(order()).toEqual(["api", "web", "idle"]);
});
