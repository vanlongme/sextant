import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, expect, test } from "vitest";
import type { ConnectionState } from "../../ipc/generated/ConnectionState";
import { resetCatalogForTest, useCatalog } from "../../stores/catalog";
import { resetMetricsForTest } from "../../stores/metrics";
import { clusterEntry, flush, mockBackend } from "../../test/ipc";
import { clusterSettings } from "../../test/metrics";
import { CONNECTED, setClusterState } from "../../test/terminal";
import { ClusterSettingsRoute } from "../settings/ClusterSettingsScreen";
import { resetDraftsForTest } from "../settings/drafts";
import { ClusterScreen } from "./ClusterScreen";

beforeEach(() => {
  resetCatalogForTest();
  resetMetricsForTest();
  resetDraftsForTest();
});

async function show(state: ConnectionState) {
  const ipc = mockBackend({
    catalog_list: () => [clusterEntry({ id: "id-x", name: "x", state })],
    catalog_warnings: () => [],
    hotbar_get: () => [],
    cluster_log: () => [],
    cluster_connect: () => ({ status: "connecting" }),
    cluster_disconnect: () => null,
    resources_discover: () => [],
    cluster_settings_get: () => clusterSettings(),
  });
  await useCatalog.getState().init();
  render(
    <MemoryRouter initialEntries={["/cluster/id-x/settings"]}>
      <Routes>
        <Route path="/cluster/:id" element={<ClusterScreen />}>
          <Route index element={<p>overview page</p>} />
          <Route path="settings" element={<ClusterSettingsRoute />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  await act(flush);
  return ipc;
}

test("the Settings page of a disconnected cluster opens without connecting", async () => {
  const ipc = await show({ status: "disconnected" });
  expect(await screen.findByTestId("cluster-settings")).toBeTruthy();
  expect(screen.getByTestId("settings-back").textContent).toBe("Open x");
  await act(flush);
  expect(ipc.callsTo("cluster_connect")).toEqual([]);
  expect(screen.queryByTestId("cluster-connect")).toBeNull();
  expect(screen.queryByTestId("connection-log")).toBeNull();
});

test("Open leaves the Settings page for the Overview, which connects", async () => {
  const ipc = await show({ status: "disconnected" });
  fireEvent.click(await screen.findByTestId("settings-back"));
  await waitFor(() => expect(ipc.callsTo("cluster_connect")).toHaveLength(1));
  expect(screen.queryByTestId("cluster-settings")).toBeNull();
});

test("the Settings page of a failed cluster shows in place of the connection panel", async () => {
  await show({ status: "failed", kind: "unreachable", message: "no route" });
  expect(await screen.findByTestId("cluster-settings")).toBeTruthy();
  expect(screen.queryByTestId("cluster-reconnect")).toBeNull();
});

test("a connected cluster shows the Settings page inside its layout", async () => {
  await show(CONNECTED);
  expect(await screen.findByTestId("cluster-settings")).toBeTruthy();
  expect(screen.getByTestId("settings-back").textContent).toBe("Back to x");
  expect(screen.getByTestId("nav-overview")).toBeTruthy();
});

test("a draft survives the cluster connecting while the page is open", async () => {
  const ipc = await show({ status: "disconnected" });
  const proxy = () =>
    screen.getByTestId("settings-proxy-url") as HTMLInputElement;
  fireEvent.change(proxy(), { target: { value: "http://proxy.example:3128" } });
  expect(screen.getByTestId("settings-status").textContent).toBe(
    "Unsaved changes.",
  );

  act(() => setClusterState("id-x", CONNECTED));
  await act(flush);

  // The page moved into the cluster layout, so it mounted again and read the settings again.
  expect(screen.getByTestId("nav-overview")).toBeTruthy();
  expect(ipc.callsTo("cluster_settings_get")).toHaveLength(2);
  expect(screen.getByTestId("settings-back").textContent).toBe("Back to x");
  expect(proxy().value).toBe("http://proxy.example:3128");
  expect(screen.getByTestId("settings-status").textContent).toBe(
    "Unsaved changes.",
  );
});
