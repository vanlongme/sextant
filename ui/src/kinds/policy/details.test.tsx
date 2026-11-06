import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, test } from "vitest";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import type { KubeObject } from "../objects";
import {
  HorizontalPodAutoscalerDetail,
  LeaseDetail,
  LimitRangeDetail,
  PodDisruptionBudgetDetail,
  PriorityClassDetail,
  ResourceQuotaDetail,
  RuntimeClassDetail,
  WebhookConfigurationDetail,
} from "./PolicyDetails";

const deployments: ResourceRef = {
  group: "apps",
  version: "v1",
  plural: "deployments",
  kind: "Deployment",
  namespaced: true,
};

function show(Detail: typeof LeaseDetail, object: KubeObject) {
  render(
    <MemoryRouter>
      <Detail
        clusterId="c"
        object={object}
        resource={deployments}
        resources={[{ resource: deployments } as unknown as ApiResourceInfo]}
      />
    </MemoryRouter>,
  );
}

test("an autoscaler shows metrics, bounds and a link to its target", () => {
  show(HorizontalPodAutoscalerDetail, {
    metadata: { name: "web", namespace: "app" },
    spec: {
      scaleTargetRef: {
        apiVersion: "apps/v1",
        kind: "Deployment",
        name: "web",
      },
      minReplicas: 2,
      maxReplicas: 9,
      metrics: [
        {
          type: "Resource",
          resource: { name: "cpu", target: { averageUtilization: 50 } },
        },
      ],
    },
    status: {
      currentReplicas: 3,
      desiredReplicas: 4,
      currentMetrics: [
        {
          type: "Resource",
          resource: { name: "cpu", current: { averageUtilization: 20 } },
        },
      ],
    },
  });
  const table = screen.getByTestId("detail-hpa-metrics");
  expect(within(table).getByText("20%")).toBeTruthy();
  expect(within(table).getByText("50%")).toBeTruthy();
  expect(screen.getByText("9")).toBeTruthy();
  expect(screen.getByText("Current replicas").nextSibling?.textContent).toBe(
    "3",
  );
  expect(screen.getByRole("link", { name: "Deployment web" })).toBeTruthy();
});

test("a budget shows its selector and counts", () => {
  show(PodDisruptionBudgetDetail, {
    metadata: { name: "b" },
    spec: { minAvailable: 1, selector: { matchLabels: { app: "web" } } },
    status: {
      currentHealthy: 3,
      desiredHealthy: 1,
      disruptionsAllowed: 2,
      expectedPods: 3,
    },
  });
  expect(screen.getByText("app=web")).toBeTruthy();
  expect(screen.getByText("Allowed disruptions").nextSibling?.textContent).toBe(
    "2",
  );
  expect(screen.getByText("Expected pods").nextSibling?.textContent).toBe("3");
});

test("a quota shows usage and scopes", () => {
  show(ResourceQuotaDetail, {
    metadata: { name: "q" },
    spec: { scopes: ["NotTerminating"] },
    status: { hard: { pods: "10" }, used: { pods: "3" } },
  });
  expect(screen.getByText("NotTerminating")).toBeTruthy();
  const table = screen.getByTestId("detail-quota");
  expect(within(table).getByText("pods")).toBeTruthy();
  expect(within(table).getByText("3")).toBeTruthy();
  expect(within(table).getByText("10")).toBeTruthy();
});

test("a limit range lists its limits", () => {
  show(LimitRangeDetail, {
    metadata: { name: "l" },
    spec: {
      limits: [{ type: "Container", max: { cpu: "2" }, default: { cpu: "1" } }],
    },
  });
  const table = screen.getByTestId("detail-limits");
  expect(within(table).getByText("Container")).toBeTruthy();
  expect(within(table).getByText("cpu")).toBeTruthy();
});

test("a priority class shows value, preemption and description", () => {
  show(PriorityClassDetail, {
    metadata: { name: "p" },
    value: 1000,
    preemptionPolicy: "Never",
    description: "batch work",
  });
  expect(screen.getByText("1000")).toBeTruthy();
  expect(screen.getByText("Never")).toBeTruthy();
  expect(screen.getByText("batch work")).toBeTruthy();
});

test("a runtime class shows its handler", () => {
  show(RuntimeClassDetail, { metadata: { name: "r" }, handler: "runsc" });
  expect(screen.getByText("runsc")).toBeTruthy();
});

test("a lease shows holder, duration, transitions and times", () => {
  show(LeaseDetail, {
    metadata: { name: "l" },
    spec: {
      holderIdentity: "node-a",
      leaseDurationSeconds: 15,
      leaseTransitions: 4,
      acquireTime: "2026-01-01T00:00:00Z",
      renewTime: "2026-01-02T00:00:00Z",
    },
  });
  expect(screen.getByText("node-a")).toBeTruthy();
  expect(screen.getByText("15s")).toBeTruthy();
  expect(screen.getByText("4")).toBeTruthy();
  expect(screen.getByText("2026-01-01T00:00:00Z")).toBeTruthy();
  expect(screen.getByText("2026-01-02T00:00:00Z")).toBeTruthy();
});

test("a webhook configuration shows each webhook's settings and rules", () => {
  show(WebhookConfigurationDetail, {
    metadata: { name: "w" },
    webhooks: [
      {
        name: "check.example.com",
        clientConfig: {
          service: { namespace: "sys", name: "hook", port: 443, path: "/v" },
        },
        failurePolicy: "Fail",
        matchPolicy: "Equivalent",
        sideEffects: "None",
        timeoutSeconds: 10,
        namespaceSelector: { matchLabels: { team: "a" } },
        rules: [
          {
            operations: ["CREATE"],
            apiGroups: [""],
            apiVersions: ["v1"],
            resources: ["pods"],
            scope: "Namespaced",
          },
        ],
      },
    ],
  });
  expect(screen.getByText("sys/hook:443/v")).toBeTruthy();
  expect(screen.getByText("Fail")).toBeTruthy();
  expect(screen.getByText("Equivalent")).toBeTruthy();
  expect(screen.getByText("None")).toBeTruthy();
  expect(screen.getByText("10s")).toBeTruthy();
  expect(screen.getByText("team=a")).toBeTruthy();
  expect(screen.getByText("CREATE")).toBeTruthy();
  expect(screen.getByText("Namespaced")).toBeTruthy();
});
