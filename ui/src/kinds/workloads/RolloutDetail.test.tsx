import { act, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { WatchEvent } from "../../ipc/generated/WatchEvent";
import { resetResourcesForTest } from "../../stores/resources";
import { flush, mockBackend } from "../../test/ipc";
import { DEPLOYMENTS } from "../refs";
import { RolloutDetail } from "./RolloutDetail";

beforeEach(() => resetResourcesForTest());
afterEach(() => resetResourcesForTest());

test("shows replicas, selector, strategy and the pods it owns", async () => {
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
    metadata: { name: "web", namespace: "n" },
    spec: {
      replicas: 2,
      selector: { matchLabels: { app: "web" } },
      strategy: {
        type: "RollingUpdate",
        rollingUpdate: { maxSurge: "25%", maxUnavailable: 1 },
      },
    },
    status: { updatedReplicas: 1, readyReplicas: 2, availableReplicas: 2 },
  };
  render(
    <MemoryRouter>
      <RolloutDetail
        clusterId="c"
        object={object}
        resource={DEPLOYMENTS}
        resources={[]}
      />
    </MemoryRouter>,
  );
  await act(flush);
  await act(async () => {
    send({
      type: "snapshot",
      items: [
        { metadata: { name: "mine", namespace: "n", labels: { app: "web" } } },
        {
          metadata: {
            name: "other-ns",
            namespace: "m",
            labels: { app: "web" },
          },
        },
        { metadata: { name: "unlabelled", namespace: "n" } },
      ],
    } as WatchEvent);
    await flush();
  });
  expect(
    screen.getByText("2 desired, 1 updated, 2 ready, 2 available"),
  ).toBeTruthy();
  expect(screen.getByText("app=web")).toBeTruthy();
  expect(
    screen.getByText("RollingUpdate maxSurge=25% maxUnavailable=1"),
  ).toBeTruthy();
  const pods = within(screen.getByTestId("detail-pods"));
  expect(pods.getByText("mine")).toBeTruthy();
  expect(pods.queryByText("other-ns")).toBeNull();
  expect(pods.queryByText("unlabelled")).toBeNull();
});
