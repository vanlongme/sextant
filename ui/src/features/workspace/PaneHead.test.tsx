import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resetCatalogForTest } from "../../stores/catalog";
import { resetShellForTest } from "../../stores/shell";
import { resetWorkspaceForTest, useWorkspace } from "../../stores/workspace";
import { clusterSettings } from "../../test/metrics";
import { connectClusters, setClusterState } from "../../test/terminal";
import {
  showWorkspace,
  wsLayout,
  wsNode,
  wsPane,
  wsTab,
} from "../../test/workspace";
import type { WorkspaceView } from "./layout";

function one(view: WorkspaceView = "pods") {
  return wsLayout([wsPane("p1", [wsTab("t1", "a", { view })])]);
}

const NODES = { nodes: [wsNode("n1", true), wsNode("n2", false)] };

beforeEach(() => {
  resetCatalogForTest();
  resetShellForTest();
  resetWorkspaceForTest();
  connectClusters({ id: "a", name: "alpha" }, { id: "b", name: "beta" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

test("the head shows the cluster, its status, the view picker and the meta line", async () => {
  await showWorkspace(one(), {
    rows: NODES,
    handlers: {
      cluster_settings_get: () => clusterSettings({ defaultNamespace: "shop" }),
    },
  });
  const pane = screen.getByTestId("workspace-pane");

  expect(within(pane).getByRole("heading", { level: 2 }).textContent).toBe(
    "alpha",
  );
  expect(within(pane).getByText("Connected")).toBeTruthy();
  expect(
    within(screen.getByTestId("workspace-view"))
      .getAllByRole("radio")
      .map((r) => [
        (r as HTMLInputElement).value,
        (r as HTMLInputElement).checked,
      ]),
  ).toEqual([
    ["overview", false],
    ["pods", true],
    ["events", false],
  ]);
  expect(screen.getByTestId("workspace-view").getAttribute("aria-label")).toBe(
    "View",
  );
  expect((await screen.findByTestId("workspace-meta")).textContent).toBe(
    "kind v1.33.1 · 1 of 2 nodes ready · namespace shop",
  );
});

test("without a default namespace the meta line says all namespaces; Nodes not in yet are left out", async () => {
  await showWorkspace(one());

  await vi.waitFor(() =>
    expect(screen.getByTestId("workspace-meta").textContent).toBe(
      "kind v1.33.1 · all namespaces",
    ),
  );
  expect(useWorkspace.getState().namespaces).toEqual({ t1: null });
});

test("picking a view changes the tab", async () => {
  await showWorkspace(one());

  fireEvent.click(
    within(screen.getByTestId("workspace-view-events")).getByRole("radio"),
  );

  expect(useWorkspace.getState().layout.panes[0].tabs[0].view).toBe("events");
  expect(screen.getByTestId("workspace-tab").getAttribute("data-view")).toBe(
    "events",
  );
  expect(screen.getByTestId("workspace-pane").getAttribute("aria-label")).toBe(
    "Pane 1 of 1: alpha · Events",
  );
});

test.each([
  ["overview", "/cluster/a"],
  ["pods", "/cluster/a/r/core/pods"],
  ["events", "/cluster/a/r/core/events"],
] as const)(
  "Open the full cluster screen from %s goes to %s",
  async (view, path) => {
    await showWorkspace(one(view));
    const open = screen.getByTestId("workspace-open-full");
    expect(open.getAttribute("aria-label")).toBe(
      "Open the full cluster screen",
    );

    fireEvent.click(open);

    expect(screen.getByTestId("where").textContent).toBe(path);
  },
);

test("a Disconnected cluster connects each time its tab becomes active", async () => {
  setClusterState("b", { status: "disconnected" });
  const ipc = await showWorkspace(
    wsLayout([wsPane("p1", [wsTab("t1", "a"), wsTab("t2", "b")])]),
  );
  expect(ipc.callsTo("cluster_connect")).toEqual([]);

  fireEvent.click(screen.getByRole("tab", { name: "beta · Pods" }));
  expect(ipc.callsTo("cluster_connect")).toEqual([{ id: "b" }]);
  // Still Disconnected (the mock does not connect): the pane offers Connect.
  fireEvent.click(screen.getByTestId("workspace-connect"));
  expect(ipc.callsTo("cluster_connect")).toEqual([{ id: "b" }, { id: "b" }]);

  fireEvent.click(screen.getByRole("tab", { name: "alpha · Pods" }));
  fireEvent.click(screen.getByRole("tab", { name: "beta · Pods" }));
  expect(ipc.callsTo("cluster_connect")).toHaveLength(3);
});

test("a cluster that is disconnected while its tab is active is not connected again", async () => {
  const ipc = await showWorkspace(one());

  setClusterState("a", { status: "disconnected" });

  expect(await screen.findByTestId("workspace-connect")).toBeTruthy();
  expect(ipc.callsTo("cluster_connect")).toEqual([]);
});

test("while Connecting, the pane shows a spinner", async () => {
  setClusterState("a", { status: "connecting" });
  await showWorkspace(one());

  expect(screen.getByTestId("workspace-connecting").textContent).toBe(
    "Connecting to alpha…",
  );
  expect(screen.getByText("Connecting")).toBeTruthy();
});

test("a Failed cluster says so, with Reconnect and the connection log", async () => {
  setClusterState("a", {
    status: "failed",
    kind: "unreachable",
    message: "dial tcp 10.0.0.1:6443: i/o timeout",
  });
  const ipc = await showWorkspace(one());
  const failed = screen.getByTestId("workspace-failed");

  expect(within(failed).getByRole("heading", { level: 3 }).textContent).toBe(
    "Cannot reach the cluster",
  );
  expect(failed.textContent).toContain("dial tcp 10.0.0.1:6443: i/o timeout");
  expect(failed.textContent).toContain(
    "Check the network or VPN and reconnect. The other panes keep their connections.",
  );
  // Without the cluster's info, only the namespace part is known.
  expect((await screen.findByTestId("workspace-meta")).textContent).toBe(
    "all namespaces",
  );

  fireEvent.click(screen.getByTestId("workspace-reconnect"));
  expect(ipc.callsTo("cluster_connect")).toEqual([{ id: "a" }]);

  const log = screen.getByTestId("workspace-connection-log");
  expect(log.textContent).toBe("Connection log");
  fireEvent.click(log);
  expect(screen.getByTestId("where").textContent).toBe("/cluster/a");
});

test("closing a tab or leaving the page never disconnects", async () => {
  const ipc = await showWorkspace(
    wsLayout([wsPane("p1", [wsTab("t1", "a"), wsTab("t2", "b")])]),
  );

  fireEvent.click(screen.getAllByTestId("workspace-tab-close")[0]);
  cleanup();

  expect(ipc.callsTo("cluster_disconnect")).toEqual([]);
});
