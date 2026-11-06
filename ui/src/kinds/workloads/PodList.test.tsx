import { act, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { WatchEvent } from "../../ipc/generated/WatchEvent";
import { resetResourcesForTest } from "../../stores/resources";
import { flush, mockBackend } from "../../test/ipc";
import type { KubeObject } from "../objects";
import { PodList } from "./PodList";

function live() {
  let send: (e: WatchEvent) => void = () => {};
  mockBackend({
    resources_subscribe: (a: {
      onEvent: { onmessage: (e: WatchEvent) => void };
    }) => {
      send = a.onEvent.onmessage;
      return "sub";
    },
    resources_unsubscribe: () => null,
  });
  return (items: KubeObject[]) =>
    act(async () => {
      send({ type: "snapshot", items } as WatchEvent);
      await flush();
    });
}

const show = (match: (p: KubeObject) => boolean, namespace?: string) =>
  render(
    <MemoryRouter>
      <PodList clusterId="c" match={match} namespace={namespace} />
    </MemoryRouter>,
  );

beforeEach(() => resetResourcesForTest());
afterEach(() => resetResourcesForTest());

test("lists the matching pods with status and a link", async () => {
  const snapshot = live();
  show((p) => p.metadata.labels?.app === "web", "n");
  await act(flush);
  await snapshot([
    {
      metadata: { name: "a", namespace: "n", labels: { app: "web" } },
      status: { phase: "Running" },
    },
    { metadata: { name: "b", namespace: "n", labels: { app: "db" } } },
    { metadata: { name: "c", namespace: "other", labels: { app: "web" } } },
  ]);
  const table = within(screen.getByTestId("detail-pods"));
  expect(table.getByRole("link", { name: "a" }).getAttribute("href")).toBe(
    "/cluster/c/r/core/pods?object=n%2Fa",
  );
  expect(table.getByText("Running")).toBeTruthy();
  expect(table.queryByText("b")).toBeNull();
  expect(table.queryByText("c")).toBeNull();
});

test("shows a spinner while loading", async () => {
  live();
  show(() => true);
  await act(flush);
  expect(screen.getByTestId("detail-pods-loading")).toBeTruthy();
});

test("says when no pod matches", async () => {
  const snapshot = live();
  show(() => false);
  await act(flush);
  await snapshot([{ metadata: { name: "a", namespace: "n" } }]);
  expect(screen.getByText("No pods.")).toBeTruthy();
});

test("says so when pods cannot be listed", async () => {
  mockBackend({
    resources_subscribe: () => {
      throw { code: "Forbidden", message: "pods is forbidden" };
    },
    resources_unsubscribe: () => null,
  });
  show(() => true);
  await act(flush);
  expect(screen.getByRole("alert").textContent).toContain("pods is forbidden");
  expect(screen.queryByText("No pods.")).toBeNull();
});
