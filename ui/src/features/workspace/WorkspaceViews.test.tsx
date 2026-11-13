import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resetCatalogForTest } from "../../stores/catalog";
import { resetShellForTest } from "../../stores/shell";
import { resetWorkspaceForTest, useWorkspace } from "../../stores/workspace";
import { clusterSettings } from "../../test/metrics";
import { mockElementSize } from "../../test/size";
import { connectClusters } from "../../test/terminal";
import {
  showWorkspace,
  wsEvent,
  wsLayout,
  wsNode,
  wsPane,
  wsPod,
  wsTab,
} from "../../test/workspace";
import type { WorkspaceView } from "./layout";

function one(view: WorkspaceView) {
  return wsLayout([wsPane("p1", [wsTab("t1", "a", { view })])]);
}

const PODS = [
  wsPod("web-1", "shop", { restarts: 2, images: ["nginx:1.27", "envoy:1"] }),
  wsPod("db-1", "default", { phase: "Pending", images: ["postgres:16"] }),
];

function rows(testId: string): string[] {
  return screen.getAllByTestId(testId).map((r) => r.textContent ?? "");
}

beforeEach(() => {
  resetCatalogForTest();
  resetShellForTest();
  resetWorkspaceForTest();
  connectClusters({ id: "a", name: "alpha" }, { id: "b", name: "beta" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

test("Overview shows the stat tiles and the warnings of the last hour, newest first", async () => {
  await showWorkspace(one("overview"), {
    rows: {
      nodes: [wsNode("n1", true), wsNode("n2", false)],
      pods: PODS,
      events: [
        wsEvent("e1", { type: "Warning", minutes: 30, message: "Back-off" }),
        wsEvent("e2", {
          type: "Warning",
          minutes: 5,
          kind: "Deployment",
          name: "web",
          message: "Scaled",
        }),
        wsEvent("e3", { type: "Normal", minutes: 1 }),
        wsEvent("e4", { type: "Warning", minutes: 90 }),
      ],
    },
  });

  expect(screen.getByTestId("workspace-overview")).toBeTruthy();
  expect(
    [
      "workspace-stat-version",
      "workspace-stat-nodes",
      "workspace-stat-pods",
      "workspace-stat-namespaces",
    ].map((id) => screen.getByTestId(id).textContent),
  ).toEqual([
    "Versionv1.33.1 kind",
    "Nodes1 of 2 ready",
    "Pods1 running",
    "Namespaces2",
  ]);
  expect(rows("workspace-event")).toEqual([
    "5mDeployment/webScaled",
    "30mPod/web-1Back-off",
  ]);
});

test("Overview without recent warnings says so", async () => {
  await showWorkspace(one("overview"), {
    rows: { nodes: [], pods: [], events: [wsEvent("e1", { minutes: 2 })] },
  });

  expect(screen.getByTestId("workspace-warnings").textContent).toBe(
    "No warnings in the last hour.",
  );
});

test("Pods lists the cluster's Pods, with the first container's image from the watched rows", async () => {
  await showWorkspace(one("pods"), {
    rows: { nodes: [], pods: [...PODS, wsPod("job-1", "shop")] },
  });

  expect(rows("workspace-pod")).toEqual([
    "web-1Running2nginx:1.27 +13m",
    "db-1Pending0postgres:163m",
    "job-1Running0—3m",
  ]);
  expect(screen.getByTestId("workspace-pod-count").textContent).toBe("3 pods");
  expect(
    within(screen.getByTestId("workspace-pods"))
      .getAllByRole("columnheader")
      .map((h) => h.textContent),
  ).toEqual(["Name", "Status", "Restarts", "Image", "Age"]);
});

test("Pods starts on the cluster's default namespace, and the picker changes it", async () => {
  await showWorkspace(one("pods"), {
    rows: { nodes: [], pods: PODS },
    handlers: {
      cluster_settings_get: () => clusterSettings({ defaultNamespace: "shop" }),
    },
  });

  await waitFor(() =>
    expect(screen.getByTestId("workspace-pod-count").textContent).toBe("1 pod"),
  );
  expect(screen.getByTestId("workspace-namespace").textContent).toBe("shop");

  fireEvent.keyDown(screen.getByTestId("workspace-namespace"), {
    key: "Enter",
  });
  fireEvent.click(
    await screen.findByRole("option", { name: "All namespaces" }),
  );

  expect(screen.getByTestId("workspace-pod-count").textContent).toBe("2 pods");
  expect(useWorkspace.getState().namespaces).toEqual({ t1: null });
  expect(screen.getByTestId("workspace-meta").textContent).toBe(
    "kind v1.33.1 · 0 of 0 nodes ready · all namespaces",
  );
});

test("Pods without Pods says where there are none", async () => {
  await showWorkspace(one("pods"), {
    rows: { nodes: [], pods: [] },
  });

  await waitFor(() =>
    expect(screen.getByTestId("workspace-pods").textContent).toContain(
      "No Pods in this cluster.",
    ),
  );
  expect(screen.getByTestId("workspace-pod-count").textContent).toBe("0 pods");

  useWorkspace.getState().setNamespace("t1", "shop");
  expect(await screen.findByText("No Pods in shop.")).toBeTruthy();
});

test("a Pod row opens the Pod's drawer in the full cluster screen", async () => {
  await showWorkspace(one("pods"), { rows: { nodes: [], pods: PODS } });

  fireEvent.click(screen.getAllByTestId("workspace-pod")[0]);

  expect(screen.getByTestId("where").textContent).toBe(
    "/cluster/a/r/core/pods?object=shop%2Fweb-1",
  );
});

test("more than 200 Pods are virtualised; 200 are not", async () => {
  mockElementSize();
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => wsPod(`p-${i}`, "shop"));
  await showWorkspace(one("pods"), { rows: { nodes: [], pods: many(201) } });

  const pods = screen.getByTestId("workspace-pods");
  expect(within(pods).getByRole("grid")).toBeTruthy();
  expect(screen.getByTestId("workspace-pod-count").textContent).toBe(
    "201 pods",
  );
  expect(screen.getAllByTestId("workspace-pod").length).toBeLessThan(201);
});

test("200 Pods are a plain table", async () => {
  const many = Array.from({ length: 200 }, (_, i) => wsPod(`p-${i}`, "shop"));
  await showWorkspace(one("pods"), { rows: { nodes: [], pods: many } });

  expect(within(screen.getByTestId("workspace-pods")).queryByRole("grid")).toBe(
    null,
  );
  expect(screen.getAllByTestId("workspace-pod")).toHaveLength(200);
});

test("Events shows the last hour's events, newest first, at most 200", async () => {
  const events = [
    wsEvent("w1", { type: "Warning", minutes: 3, message: "Failed" }),
    wsEvent("old", { minutes: 75 }),
    ...Array.from({ length: 205 }, (_, i) =>
      wsEvent(`n${i}`, { minutes: 4 + i / 10 }),
    ),
  ];
  await showWorkspace(one("events"), { rows: { nodes: [], events } });

  const shown = rows("workspace-event");
  expect(shown).toHaveLength(200);
  expect(shown[0]).toBe("3mWarningPod/web-1Failed");
  expect(shown[1]).toBe("4mNormalPod/web-1message n0");
  expect(shown.some((r) => r.includes("message old"))).toBe(false);
});

test("Events without recent events says so", async () => {
  await showWorkspace(one("events"), {
    rows: { nodes: [], events: [wsEvent("old", { minutes: 61 })] },
  });

  expect(screen.getByTestId("workspace-events").textContent).toBe(
    "No events in the last hour.",
  );
});

test("only the active tab of each pane holds watches", async () => {
  const ipc = await showWorkspace(
    wsLayout([
      wsPane("p1", [
        wsTab("t1", "a", { view: "events" }),
        wsTab("t2", "b", { view: "pods" }),
      ]),
    ]),
    { rows: { nodes: [], events: [] } },
  );
  const watched = () =>
    ipc
      .callsTo("resources_subscribe")
      .map(
        (c) => `${c.clusterId}:${(c.resource as { plural: string }).plural}`,
      );

  expect(watched().sort()).toEqual(["a:events", "a:nodes"]);

  fireEvent.click(screen.getByRole("tab", { name: "beta · Pods" }));

  await waitFor(() =>
    expect(
      watched()
        .filter((w) => w.startsWith("b:"))
        .sort(),
    ).toEqual(["b:nodes", "b:pods"]),
  );
  expect(ipc.callsTo("resources_unsubscribe").length).toBeGreaterThan(0);
});
