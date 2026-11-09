import { fireEvent, render, screen, within } from "@testing-library/react";
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

test("regular containers list their ports with Forward on TCP ones; init containers keep chips", () => {
  const object = {
    metadata: { name: "web-1", namespace: "shop" },
    spec: {
      initContainers: [
        { name: "setup", image: "busybox", ports: [{ containerPort: 9000 }] },
      ],
      containers: [
        {
          name: "app",
          image: "web:1",
          ports: [
            { name: "http", containerPort: 8080 },
            { name: "dns", containerPort: 53, protocol: "UDP" },
            { containerPort: 9090, protocol: "TCP" },
          ],
        },
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

  const app = screen.getByTestId("detail-container-app");
  expect(within(app).getByText("Ports")).toBeTruthy();
  const lines = within(screen.getByTestId("pod-ports-app")).getAllByRole(
    "listitem",
  );
  expect(lines.map((li) => li.querySelector(".portText")?.textContent)).toEqual(
    ["http 8080/TCP", "dns 53/UDP", "9090/TCP"],
  );
  expect(screen.getByTestId("pod-port-forward-app-8080")).toBeTruthy();
  expect(screen.getByTestId("pod-port-forward-app-9090")).toBeTruthy();
  expect(screen.queryByTestId("pod-port-forward-app-53")).toBeNull();
  expect(app.querySelectorAll(".chip")).toHaveLength(0);

  const setup = screen.getByTestId("detail-container-setup");
  expect(
    Array.from(setup.querySelectorAll(".chip")).map((c) => c.textContent),
  ).toEqual(["9000/TCP"]);
  expect(screen.queryByTestId("pod-port-forward-setup-9000")).toBeNull();

  fireEvent.click(screen.getByTestId("pod-port-forward-app-9090"));
  expect(
    screen.getByRole("dialog", { name: "Port forward pod/web-1" }),
  ).toBeTruthy();
  expect(screen.getByTestId("pf-target-port").textContent).toBe("9090/TCP");
});
