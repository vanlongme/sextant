import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, test } from "vitest";
import { OverviewSections } from "../../features/details/OverviewSections";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { KubeObject } from "../objects";
import { PODS } from "../refs";
import { kindSpec } from "../registry";
import "./index";

function info(
  group: string,
  plural: string,
  kind: string,
  namespaced: boolean,
): ApiResourceInfo {
  return {
    resource: { group, version: "v1", plural, kind, namespaced },
    verbs: [],
    shortNames: [],
    canList: true,
    canWatch: true,
    canCreate: true,
    canUpdate: true,
    canPatch: true,
    canDelete: true,
  };
}

const RESOURCES = [
  info("", "pods", "Pod", true),
  info("", "nodes", "Node", false),
  info("", "namespaces", "Namespace", false),
  info("", "serviceaccounts", "ServiceAccount", true),
  info("", "secrets", "Secret", true),
  info("", "configmaps", "ConfigMap", true),
  info("", "persistentvolumeclaims", "PersistentVolumeClaim", true),
  info("scheduling.k8s.io", "priorityclasses", "PriorityClass", false),
];

const IMAGE = "registry.local/team/web:1.2";

const POD: KubeObject = {
  metadata: {
    name: "web-1",
    namespace: "shop",
    creationTimestamp: "2026-01-01T00:00:00Z",
  },
  spec: {
    nodeName: "node-1",
    serviceAccountName: "robot",
    priorityClassName: "high",
    nodeSelector: { disktype: "ssd" },
    tolerations: [
      {
        key: "dedicated",
        operator: "Equal",
        value: "gpu",
        effect: "NoSchedule",
      },
      { operator: "Exists" },
    ],
    affinity: {
      nodeAffinity: {
        requiredDuringSchedulingIgnoredDuringExecution: {
          nodeSelectorTerms: [
            {
              matchExpressions: [
                { key: "zone", operator: "In", values: ["a", "b"] },
              ],
            },
          ],
        },
      },
      podAntiAffinity: {
        preferredDuringSchedulingIgnoredDuringExecution: [
          {
            weight: 50,
            podAffinityTerm: {
              labelSelector: { matchLabels: { app: "web" } },
              topologyKey: "kubernetes.io/hostname",
            },
          },
        ],
      },
    },
    volumes: [
      { name: "config", configMap: { name: "settings" } },
      { name: "data", persistentVolumeClaim: { claimName: "data-web-1" } },
    ],
    initContainers: [
      { name: "setup", image: "busybox", ports: [{ containerPort: 9000 }] },
    ],
    containers: [
      {
        name: "app",
        image: IMAGE,
        ports: [
          { name: "http", containerPort: 8080 },
          { name: "dns", containerPort: 53, protocol: "UDP" },
        ],
        resources: {
          requests: { cpu: "250m", memory: "512Mi" },
          limits: { memory: "1Gi" },
        },
        env: [
          { name: "MODE", value: "prod" },
          {
            name: "FROM_SECRET",
            valueFrom: { secretKeyRef: { name: "creds", key: "password" } },
          },
          {
            name: "POD_NAME",
            valueFrom: { fieldRef: { fieldPath: "metadata.name" } },
          },
          {
            name: "CPU",
            valueFrom: { resourceFieldRef: { resource: "limits.cpu" } },
          },
        ],
        envFrom: [{ configMapRef: { name: "settings" }, prefix: "APP_" }],
        volumeMounts: [{ name: "config", mountPath: "/etc/app" }],
        livenessProbe: { tcpSocket: { port: 8080 } },
      },
    ],
  },
  status: {
    phase: "Running",
    podIP: "10.0.0.7",
    qosClass: "Burstable",
    conditions: [
      { type: "Ready", status: "True" },
      { type: "PodScheduled", status: "False", reason: "Unschedulable" },
    ],
    initContainerStatuses: [
      {
        name: "setup",
        ready: false,
        restartCount: 0,
        state: { terminated: { exitCode: 0 } },
      },
    ],
    containerStatuses: [
      { name: "app", ready: true, restartCount: 3, state: { running: {} } },
    ],
  },
};

function overview(object: KubeObject = POD) {
  const columns = kindSpec("", "pods")?.columns?.(RESOURCES[0]) ?? [];
  return render(
    <MemoryRouter>
      <OverviewSections
        clusterId="c"
        resource={PODS}
        object={object}
        resources={RESOURCES}
        columns={columns}
      />
    </MemoryRouter>,
  );
}

const ids = (selector: string) =>
  [...document.querySelectorAll<HTMLElement>(selector)].map(
    (el) => el.dataset.testid,
  );

/** The lines of an item's sub-row, by its key. */
function lines(item: HTMLElement, label: string): string[] {
  const key = [...item.querySelectorAll(".subKey")].find(
    (k) => k.textContent === label,
  );
  const box = key?.nextElementSibling;
  return box ? [...box.children].map((c) => c.textContent ?? "") : [];
}

test("a Pod's Overview has its six sections in order, with counts on Volumes and Containers", () => {
  overview();
  expect(ids('[data-testid^="detail-section-toggle-"]')).toEqual([
    "detail-section-toggle-summary",
    "detail-section-toggle-relations",
    "detail-section-toggle-volumes",
    "detail-section-toggle-scheduling",
    "detail-section-toggle-containers",
    "detail-section-toggle-metadata",
  ]);
  expect(
    screen.getByTestId("detail-section-toggle-volumes").querySelector(".count")
      ?.textContent,
  ).toBe("2");
  expect(
    screen
      .getByTestId("detail-section-toggle-containers")
      .querySelector(".count")?.textContent,
  ).toBe("2");
});

test("the Summary shows the Pod's stats, the creation time and a Priority class link", () => {
  overview();
  expect(ids('[data-testid^="detail-stat-"]')).toEqual([
    "detail-stat-status",
    "detail-stat-ready",
    "detail-stat-restarts",
    "detail-stat-age",
    "detail-stat-qos",
    "detail-stat-ip",
    "detail-stat-cpu",
    "detail-stat-memory",
    "detail-stat-priority",
  ]);
  expect(
    within(screen.getByTestId("detail-stat-status")).getByText("Running"),
  ).toBeTruthy();
  expect(
    within(screen.getByTestId("detail-stat-ready")).getByText("1/1"),
  ).toBeTruthy();
  expect(screen.getByTestId("detail-stat-age").getAttribute("title")).toBe(
    "Created 2026-01-01 00:00:00 UTC",
  );
  expect(
    within(screen.getByTestId("detail-stat-ip"))
      .getByText("10.0.0.7")
      .closest(".mono"),
  ).not.toBeNull();
  expect(
    within(screen.getByTestId("detail-stat-priority")).getByRole("link", {
      name: "high",
    }),
  ).toBeTruthy();
});

test("Relations link the Node and the service account, and name what is missing", () => {
  const view = overview();
  const relations = within(screen.getByTestId("detail-relations"));
  expect(relations.getByRole("link", { name: "shop" })).toBeTruthy();
  expect(relations.getByText("None")).toBeTruthy();
  expect(relations.getByRole("link", { name: "node-1" })).toBeTruthy();
  expect(
    relations.getByRole("link", { name: "robot" }).getAttribute("href"),
  ).toContain(encodeURIComponent("shop/robot"));
  view.unmount();
  overview({
    ...POD,
    spec: { ...POD.spec, nodeName: undefined, serviceAccountName: "" },
  });
  const bare = within(screen.getByTestId("detail-relations"));
  expect(bare.getByText("Not scheduled")).toBeTruthy();
  expect(bare.getByRole("link", { name: "default" })).toBeTruthy();
});

test("Scheduling shows the node selector, tolerations, affinities and conditions", () => {
  overview();
  const scheduling = screen.getByTestId("detail-scheduling");
  expect(within(scheduling).getByText("disktype=ssd")).toBeTruthy();

  const tolerations = screen.getByTestId("detail-tolerations");
  expect(within(tolerations).getByText("2")).toBeTruthy();
  expect(within(tolerations).getByText("NoSchedule, All")).toBeTruthy();
  fireEvent.click(screen.getByTestId("detail-expand-tolerations"));
  const rows = within(tolerations)
    .getAllByRole("row")
    .map((r) => [...r.querySelectorAll("th, td")].map((c) => c.textContent));
  expect(rows).toEqual([
    ["Key", "Operator", "Value", "Effect"],
    ["dedicated", "Equal", "gpu", "NoSchedule"],
    ["—", "Exists", "—", "All"],
  ]);

  const affinities = screen.getByTestId("detail-affinities");
  expect(
    within(affinities).getByText("Node affinity, Pod anti-affinity"),
  ).toBeTruthy();
  fireEvent.click(screen.getByTestId("detail-expand-affinities"));
  expect(within(affinities).getByText("zone In (a, b)")).toBeTruthy();
  expect(within(affinities).getByText("app=web")).toBeTruthy();
  expect(within(affinities).getByText("kubernetes.io/hostname")).toBeTruthy();
  expect(within(affinities).getByText("preferred, weight 50")).toBeTruthy();

  const conditions = within(screen.getByTestId("detail-conditions"));
  expect(
    conditions.getByText("Ready").closest("li")?.getAttribute("title"),
  ).toBe("Ready: True");
  expect(
    conditions.getByText("PodScheduled").closest("li")?.getAttribute("title"),
  ).toBe("PodScheduled: False (Unschedulable)");
});

test("a Pod with no scheduling rules says None for each", () => {
  overview({
    metadata: { name: "bare", namespace: "shop" },
    spec: { containers: [] },
  });
  const facts = [
    ...screen.getByTestId("detail-scheduling").querySelectorAll(".factRow"),
  ].map((r) => r.textContent);
  expect(facts).toEqual([
    "Node selectorNone",
    "TolerationsNone",
    "AffinitiesNone",
    "ConditionsNone",
  ]);
  expect(screen.queryByTestId("detail-tolerations")).toBeNull();
  expect(screen.queryByTestId("detail-affinities")).toBeNull();
});

test("containers list init ones first, with state badges and their sub-rows", () => {
  overview();
  expect(ids('[data-testid^="detail-container-"]')).toEqual([
    "detail-container-setup",
    "detail-container-app",
  ]);
  const setup = screen.getByTestId("detail-container-setup");
  expect(within(setup).getByText("Completed")).toBeTruthy();
  expect(within(setup).getByText("Not ready")).toBeTruthy();
  expect(within(setup).getByText("Init")).toBeTruthy();
  expect(lines(setup, "Restarts")).toEqual([]);

  const app = screen.getByTestId("detail-container-app");
  expect(within(app).getByText("Running")).toBeTruthy();
  expect(within(app).getByText("Ready")).toBeTruthy();
  expect(within(app).queryByText("Init")).toBeNull();
  const image = within(app).getByTitle(IMAGE);
  expect(image.textContent).toBe(IMAGE.replaceAll("/", "/​"));
  expect(lines(app, "Requests")).toEqual(["cpu 250m · memory 512Mi"]);
  expect(lines(app, "Limits")).toEqual(["memory 1Gi"]);
  expect(lines(app, "Env")).toEqual(["MODE=prod"]);
  expect(lines(app, "Env from")).toEqual(["ConfigMap settings prefix APP_"]);
  expect(within(app).getByRole("link", { name: "settings" })).toBeTruthy();
  expect(lines(app, "Env refs")).toEqual([
    "FROM_SECRET ← Secret creds / password",
    "POD_NAME ← field metadata.name",
    "CPU ← resource limits.cpu",
  ]);
  expect(within(app).getByRole("link", { name: "creds" })).toBeTruthy();
  expect(lines(app, "Probes")).toEqual([
    "liveness: tcp-socket :8080 delay=0s timeout=1s period=10s #success=1 #failure=3",
  ]);
  expect(lines(app, "Restarts")).toEqual(["3"]);
  expect(lines(app, "Mounts")).toEqual([]);
});

test("ports read port/protocol then name; only a regular container's TCP ports forward", () => {
  overview();
  const items = within(screen.getByTestId("pod-ports-app")).getAllByRole(
    "listitem",
  );
  expect(items.map((li) => li.querySelector(".portText")?.textContent)).toEqual(
    ["8080/TCP", "53/UDP"],
  );
  expect(items.map((li) => li.querySelector(".portName")?.textContent)).toEqual(
    ["http", "dns"],
  );
  expect(screen.getByTestId("pod-port-forward-app-8080")).toBeTruthy();
  expect(screen.queryByTestId("pod-port-forward-app-53")).toBeNull();
  expect(
    within(screen.getByTestId("pod-ports-setup"))
      .getAllByRole("listitem")
      .map((li) => li.querySelector(".portText")?.textContent),
  ).toEqual(["9000/TCP"]);
  expect(screen.queryByTestId("pod-port-forward-setup-9000")).toBeNull();

  fireEvent.click(screen.getByTestId("pod-port-forward-app-8080"));
  expect(
    screen.getByRole("dialog", { name: "Port forward pod/web-1" }),
  ).toBeTruthy();
  expect(screen.getByTestId("pf-target-port").textContent).toBe(
    "8080/TCP · http",
  );
});
