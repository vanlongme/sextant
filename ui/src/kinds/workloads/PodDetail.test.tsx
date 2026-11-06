import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, test } from "vitest";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import { PODS } from "../refs";
import { PodDetail } from "./PodDetail";

const NODES: ApiResourceInfo = {
  resource: {
    group: "",
    version: "v1",
    plural: "nodes",
    kind: "Node",
    namespaced: false,
  },
  verbs: [],
  shortNames: [],
  canList: true,
  canWatch: true,
  canCreate: true,
  canUpdate: true,
  canPatch: true,
  canDelete: true,
};

test("shows the facts and every container's details", () => {
  const object = {
    metadata: { name: "p", namespace: "n" },
    spec: {
      nodeName: "node-1",
      serviceAccountName: "robot",
      initContainers: [{ name: "i", image: "busybox" }],
      containers: [
        {
          name: "a",
          image: "web:1",
          env: [
            { name: "S", valueFrom: { secretKeyRef: { name: "s", key: "k" } } },
          ],
          volumeMounts: [{ name: "v", mountPath: "/d" }],
          livenessProbe: { tcpSocket: { port: 80 } },
        },
      ],
    },
    status: {
      phase: "Running",
      podIP: "10.0.0.7",
      hostIP: "192.168.0.2",
      qosClass: "Burstable",
      containerStatuses: [
        { name: "a", ready: true, restartCount: 0, state: { running: {} } },
      ],
    },
  };
  render(
    <MemoryRouter>
      <PodDetail
        clusterId="c"
        object={object}
        resource={PODS}
        resources={[NODES]}
      />
    </MemoryRouter>,
  );
  const a = within(screen.getByTestId("detail-container-a"));
  expect(a.getByText("web:1")).toBeTruthy();
  expect(a.getByText(/S from secret s\/k/)).toBeTruthy();
  expect(a.getByText("/d from v")).toBeTruthy();
  expect(a.getByText(/liveness: tcp-socket :80/)).toBeTruthy();
  expect(screen.getByTestId("detail-container-i")).toBeTruthy();
  expect(screen.getByText("10.0.0.7")).toBeTruthy();
  expect(screen.getByText("192.168.0.2")).toBeTruthy();
  expect(screen.getByText("Burstable")).toBeTruthy();
  expect(screen.getByText("robot")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Node node-1" })).toBeTruthy();
  expect(screen.getAllByText("Running").length).toBeGreaterThan(0);
});
