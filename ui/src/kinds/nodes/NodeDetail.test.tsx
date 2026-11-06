import { act, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { WatchEvent } from "../../ipc/generated/WatchEvent";
import { resetResourcesForTest } from "../../stores/resources";
import { flush, mockBackend } from "../../test/ipc";
import { NODES } from "../refs";
import { NodeDetail } from "./NodeDetail";

beforeEach(() => resetResourcesForTest());
afterEach(() => resetResourcesForTest());

const info = { resource: NODES } as unknown as ApiResourceInfo;

test("shows capacity, taints, addresses, versions and only this node's pods", async () => {
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
  const object = {
    metadata: { name: "n1" },
    spec: { taints: [{ key: "k", value: "v", effect: "NoSchedule" }] },
    status: {
      capacity: { cpu: "4", memory: "8Gi" },
      allocatable: { cpu: "3", pods: "110" },
      addresses: [{ type: "InternalIP", address: "10.0.0.1" }],
      nodeInfo: {
        kubeletVersion: "v1.30.0",
        containerRuntimeVersion: "containerd://1.7",
        osImage: "Debian",
        kernelVersion: "6.1",
        architecture: "amd64",
      },
    },
  };
  render(
    <MemoryRouter>
      <NodeDetail
        clusterId="c"
        object={object}
        resource={NODES}
        resources={[info]}
      />
    </MemoryRouter>,
  );
  await act(async () => {
    send({
      type: "snapshot",
      items: [
        {
          metadata: { name: "mine", namespace: "d" },
          spec: { nodeName: "n1" },
        },
        {
          metadata: { name: "other", namespace: "d" },
          spec: { nodeName: "n2" },
        },
      ],
    } as WatchEvent);
    await flush();
  });
  const cap = within(screen.getByTestId("detail-node-resources"));
  expect(cap.getByText("memory")).toBeTruthy();
  expect(cap.getByText("8Gi")).toBeTruthy();
  expect(cap.getByText("110")).toBeTruthy();
  expect(screen.getByText("k=v:NoSchedule")).toBeTruthy();
  expect(screen.getByText("10.0.0.1")).toBeTruthy();
  expect(screen.getByText("v1.30.0")).toBeTruthy();
  expect(screen.getByText("containerd://1.7")).toBeTruthy();
  expect(screen.getByText("mine")).toBeTruthy();
  expect(screen.queryByText("other")).toBeNull();
});
