import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, expect, test } from "vitest";
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

afterEach(() => resetResourcesForTest());

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
