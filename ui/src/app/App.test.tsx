import { render, screen } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { resetCatalogForTest } from "../stores/catalog";
import { clusterEntry, mockBackend } from "../test/ipc";
import { App } from "./App";

beforeEach(() => {
  resetCatalogForTest();
  window.location.hash = "";
});

test("renders the app root and opens the catalog by default", async () => {
  mockBackend({
    catalog_list: () => [clusterEntry({ contextName: "alpha" })],
    catalog_warnings: () => [],
    hotbar_get: () => [],
  });

  render(<App />);

  expect(screen.getByTestId("app-root")).toBeTruthy();
  expect(await screen.findByTestId("catalog-row-alpha")).toBeTruthy();
  expect(screen.getByTestId("hotbar")).toBeTruthy();
  expect(window.location.hash).toBe("#/catalog");
});

test("the status bar shows the connected count and the app version", async () => {
  const info = {
    version: "v1",
    distribution: "kind",
    nodeCount: 1,
    namespaces: [],
    namespacesRestricted: false,
    isAdmin: true,
  };
  mockBackend({
    catalog_list: () => [
      clusterEntry({
        contextName: "alpha",
        state: { status: "connected", info },
      }),
      clusterEntry({ contextName: "beta" }),
    ],
    catalog_warnings: () => [],
    hotbar_get: () => [],
  });

  render(<App />);

  await screen.findByText(/1 connected/);
  expect(await screen.findByText(/0\.1\.0/)).toBeTruthy();
  expect(screen.getByTestId("status-bar").textContent).toContain("1 connected");
});

test("a cluster route renders the cluster's name", async () => {
  window.location.hash = "#/cluster/id-alpha";
  mockBackend({
    catalog_list: () => [clusterEntry({ contextName: "alpha" })],
    catalog_warnings: () => [],
    hotbar_get: () => [],
  });

  render(<App />);

  expect(await screen.findByRole("heading", { name: "alpha" })).toBeTruthy();
});

test("the port forwards route shows its screen with the sidebar entry active", async () => {
  window.location.hash = "#/cluster/id-alpha/port-forwards";
  mockBackend({
    catalog_list: () => [
      clusterEntry({
        contextName: "alpha",
        state: {
          status: "connected",
          info: {
            version: "v1",
            distribution: "kind",
            nodeCount: 1,
            namespaces: [],
            namespacesRestricted: false,
            isAdmin: true,
          },
        },
      }),
    ],
    catalog_warnings: () => [],
    hotbar_get: () => [],
    resources_discover: () => [],
    ui_state_get: () => null,
    ui_state_set: () => null,
  });

  render(<App />);

  expect(await screen.findByTestId("port-forwards-screen")).toBeTruthy();
  const link = await screen.findByTestId("nav-port-forwards");
  expect(link.getAttribute("aria-current")).toBe("page");
});
