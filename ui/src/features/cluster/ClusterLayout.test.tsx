import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, expect, test, vi } from "vitest";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import type { WatchEvent } from "../../ipc/generated/WatchEvent";
import { resetResourcesForTest } from "../../stores/resources";
import { flush, mockBackend } from "../../test/ipc";
import { ResourceRoute } from "../resources/ResourceScreen";
import { ClusterLayout } from "./ClusterLayout";

const CRD: ApiResourceInfo = {
  resource: {
    group: "apiextensions.k8s.io",
    version: "v1",
    plural: "customresourcedefinitions",
    kind: "CustomResourceDefinition",
    namespaced: false,
  },
  verbs: ["list", "watch"],
  shortNames: [],
  canList: true,
  canWatch: true,
  canCreate: true,
  canUpdate: true,
  canDelete: true,
};

afterEach(() => {
  vi.useRealTimers();
  resetResourcesForTest();
});

const WIDGETS: ApiResourceInfo = {
  ...CRD,
  resource: {
    group: "e2e.test",
    version: "v1",
    plural: "widgets",
    kind: "Widget",
    namespaced: true,
  },
};

const WIDGET_CRD = {
  metadata: { name: "widgets.e2e.test", resourceVersion: "1" },
  spec: { group: "e2e.test", names: { plural: "widgets" } },
  status: { conditions: [{ type: "Established", status: "True" }] },
};

/** Renders the layout with a discovery that gives `answers` in turn, then the last. */
async function renderWithDiscovery(answers: ApiResourceInfo[][]) {
  let send: (e: WatchEvent) => void = () => {};
  let call = 0;
  const backend = mockBackend({
    ui_state_get: () => null,
    resources_discover: () => {
      const answer = answers[Math.min(call, answers.length - 1)];
      call += 1;
      return answer;
    },
    resources_subscribe: (a: {
      onEvent: { onmessage: (e: WatchEvent) => void };
    }) => {
      send = a.onEvent.onmessage;
      return "sub-1";
    },
    resources_unsubscribe: () => null,
  });
  render(
    <MemoryRouter initialEntries={["/cluster/c1"]}>
      <Routes>
        <Route
          path="/cluster/:id"
          element={
            <ClusterLayout
              clusterId="c1"
              busy={false}
              onDisconnect={() => {}}
            />
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  await act(flush);
  await waitFor(() =>
    expect(backend.callsTo("resources_subscribe")).toHaveLength(1),
  );
  const snapshot = (items: unknown[]) =>
    act(async () => {
      send({ type: "snapshot", items } as WatchEvent);
      await flush();
    });
  return { backend, snapshot };
}

test("a new CRD that discovery does not serve yet is looked for again", async () => {
  const { backend, snapshot } = await renderWithDiscovery([
    [CRD],
    [CRD],
    [CRD, WIDGETS],
  ]);
  await snapshot([]);
  await snapshot([WIDGET_CRD]);

  await screen.findByTestId("nav-crd-group-e2e.test", undefined, {
    timeout: 3000,
  });
  expect(backend.callsTo("resources_discover")).toHaveLength(3);
});

test("a CRD that becomes established later is looked for again", async () => {
  const { snapshot } = await renderWithDiscovery([
    [CRD],
    [CRD],
    [CRD],
    [CRD, WIDGETS],
  ]);
  await snapshot([]);
  await snapshot([{ ...WIDGET_CRD, status: {} }]);
  await act(flush);
  expect(screen.queryByTestId("nav-crd-group-e2e.test")).toBeNull();

  await snapshot([WIDGET_CRD]);

  await screen.findByTestId("nav-crd-group-e2e.test", undefined, {
    timeout: 3000,
  });
});

test("a deleted CRD that discovery still serves is looked for again", async () => {
  const { snapshot } = await renderWithDiscovery([
    [CRD, WIDGETS],
    [CRD, WIDGETS],
    [CRD],
  ]);
  await snapshot([WIDGET_CRD]);
  await screen.findByTestId("nav-crd-group-e2e.test");

  await snapshot([]);

  await waitFor(
    () => expect(screen.queryByTestId("nav-crd-group-e2e.test")).toBeNull(),
    { timeout: 3000 },
  );
});

test("looking again for a CRD that never shows up stops after a while", async () => {
  const { backend, snapshot } = await renderWithDiscovery([[CRD]]);
  await snapshot([]);
  vi.useFakeTimers();
  await act(async () => {
    const pending = snapshot([WIDGET_CRD]);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
  });

  await act(async () => {
    await vi.advanceTimersByTimeAsync(5 * 60_000);
  });
  const calls = backend.callsTo("resources_discover").length;
  expect(calls).toBeLessThan(10);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(5 * 60_000);
  });
  expect(backend.callsTo("resources_discover")).toHaveLength(calls);
});

test("a CRD that discovery serves causes no extra discovery", async () => {
  const { backend, snapshot } = await renderWithDiscovery([[CRD, WIDGETS]]);
  await snapshot([WIDGET_CRD]);
  await new Promise((resolve) => setTimeout(resolve, 700));
  await act(flush);
  expect(backend.callsTo("resources_discover")).toHaveLength(1);
});

test("a change in the set of CRDs re-discovers the resources", async () => {
  let send: (e: WatchEvent) => void = () => {};
  const backend = mockBackend({
    ui_state_get: () => null,
    resources_discover: () => [CRD],
    resources_subscribe: (a: {
      resource: ResourceRef;
      onEvent: { onmessage: (e: WatchEvent) => void };
    }) => {
      send = a.onEvent.onmessage;
      return "sub-1";
    },
    resources_unsubscribe: () => null,
  });
  render(
    <MemoryRouter initialEntries={["/cluster/c1/r/core/pods"]}>
      <Routes>
        <Route
          path="/cluster/:id"
          element={
            <ClusterLayout
              clusterId="c1"
              busy={false}
              onDisconnect={() => {}}
            />
          }
        >
          <Route path="r/:group/:plural" element={<ResourceRoute />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  await act(flush);
  await waitFor(() =>
    expect(backend.callsTo("resources_subscribe")).toHaveLength(1),
  );
  const item = (name: string) => ({ metadata: { name, resourceVersion: "1" } });
  await act(async () => {
    send({ type: "snapshot", items: [item("a.io")] } as WatchEvent);
    await flush();
  });
  expect(backend.callsTo("resources_discover")).toHaveLength(1);
  await act(async () => {
    send({
      type: "snapshot",
      items: [item("a.io"), item("b.io")],
    } as WatchEvent);
    await flush();
  });
  await waitFor(() =>
    expect(backend.callsTo("resources_discover")).toHaveLength(2),
  );
  expect(backend.callsTo("resources_discover")[1]).toEqual({
    clusterId: "c1",
    refresh: true,
  });
  expect(screen.getByTestId("cluster-sidebar")).toBeTruthy();
});
