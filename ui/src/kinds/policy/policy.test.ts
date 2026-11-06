import { expect, test } from "vitest";
import {
  hpaMetrics,
  hpaTargetsText,
  limitRows,
  quotaRows,
  quotaText,
  webhookRows,
} from "./policy";

const m = { name: "x" };

test("each metric type pairs its current value with its target", () => {
  const hpa = {
    metadata: m,
    spec: {
      metrics: [
        {
          type: "Resource",
          resource: {
            name: "cpu",
            target: { type: "Utilization", averageUtilization: 50 },
          },
        },
        {
          type: "ContainerResource",
          containerResource: {
            name: "memory",
            container: "a",
            target: { type: "AverageValue", averageValue: "1Gi" },
          },
        },
        {
          type: "Pods",
          pods: {
            metric: { name: "qps" },
            target: { type: "AverageValue", averageValue: "10" },
          },
        },
        {
          type: "Object",
          object: {
            metric: { name: "hits" },
            describedObject: { kind: "Ingress", name: "i" },
            target: { type: "Value", value: "5" },
          },
        },
        {
          type: "External",
          external: {
            metric: { name: "queue" },
            target: { type: "AverageValue", averageValue: "3" },
          },
        },
      ],
    },
    status: {
      currentMetrics: [
        {
          type: "Resource",
          resource: {
            name: "cpu",
            current: { averageUtilization: 20, averageValue: "1m" },
          },
        },
        {
          type: "Pods",
          pods: { metric: { name: "qps" }, current: { averageValue: "7" } },
        },
        {
          type: "Object",
          object: { metric: { name: "hits" }, current: { value: "9" } },
        },
      ],
    },
  };
  expect(hpaMetrics(hpa)).toEqual([
    { name: "cpu", on: "Pods", current: "20%", target: "50%" },
    { name: "memory", on: "container a", current: "<unknown>", target: "1Gi" },
    { name: "qps", on: "Pods", current: "7", target: "10" },
    { name: "hits", on: "Ingress/i", current: "9", target: "5" },
    { name: "queue", on: "External", current: "<unknown>", target: "3 (avg)" },
  ]);
});

test("a metric with the same type but another name is not paired", () => {
  const hpa = {
    metadata: m,
    spec: {
      metrics: [
        {
          type: "Resource",
          resource: { name: "cpu", target: { averageUtilization: 50 } },
        },
      ],
    },
    status: {
      currentMetrics: [
        {
          type: "Resource",
          resource: { name: "memory", current: { averageUtilization: 1 } },
        },
      ],
    },
  };
  expect(hpaMetrics(hpa)[0].current).toBe("<unknown>");
});

test("the Targets column reads like kubectl", () => {
  const hpa = {
    metadata: m,
    spec: {
      metrics: [
        {
          type: "Resource",
          resource: { name: "cpu", target: { averageUtilization: 50 } },
        },
        {
          type: "Resource",
          resource: { name: "memory", target: { averageUtilization: 60 } },
        },
      ],
    },
  };
  expect(hpaTargetsText(hpa)).toBe("cpu: <unknown>/50%, memory: <unknown>/60%");
  expect(hpaTargetsText({ metadata: m })).toBe("<none>");
});

test("the legacy CPU target still reads", () => {
  const hpa = {
    metadata: m,
    spec: { targetCPUUtilizationPercentage: 80 },
    status: { currentCPUUtilizationPercentage: 12 },
  };
  expect(hpaMetrics(hpa)).toEqual([
    { name: "cpu", on: "Pods", current: "12%", target: "80%" },
  ]);
});

test("quota rows pair used with hard", () => {
  expect(
    quotaRows({
      metadata: m,
      status: { hard: { pods: "10", cpu: "2" }, used: { pods: "3" } },
    }),
  ).toEqual([
    { resource: "cpu", used: "0", hard: "2" },
    { resource: "pods", used: "3", hard: "10" },
  ]);
  expect(quotaRows({ metadata: m })).toEqual([]);
});

test("quota columns split limits from the rest, as kubectl does", () => {
  expect(
    quotaText({
      metadata: m,
      status: {
        hard: { pods: "10", "limits.cpu": "2", "requests.cpu": "1" },
        used: { pods: "3" },
      },
    }),
  ).toEqual({
    request: "pods: 3/10, requests.cpu: 0/1",
    limit: "limits.cpu: 0/2",
  });
  expect(quotaText({ metadata: m })).toEqual({ request: "", limit: "" });
});

test("limit rows have one line per type and resource", () => {
  expect(
    limitRows({
      metadata: m,
      spec: {
        limits: [
          {
            type: "Container",
            max: { cpu: "2" },
            min: { cpu: "1" },
            default: { cpu: "1" },
            defaultRequest: { cpu: "500m" },
            maxLimitRequestRatio: { cpu: "2" },
          },
        ],
      },
    }),
  ).toEqual([
    {
      type: "Container",
      resource: "cpu",
      min: "1",
      max: "2",
      defaultRequest: "500m",
      defaultLimit: "1",
      ratio: "2",
    },
  ]);
});

test("a webhook configuration is read into rows", () => {
  const rows = webhookRows({
    metadata: m,
    webhooks: [
      {
        name: "a",
        clientConfig: { url: "https://h/x" },
        timeoutSeconds: 5,
        rules: [{ operations: ["*"], resources: ["pods"] }],
      },
    ],
  });
  expect(rows[0]).toMatchObject({
    name: "a",
    client: "https://h/x",
    timeout: "5s",
  });
  expect(rows[0].rules[0]).toMatchObject({
    operations: "*",
    resources: "pods",
    scope: "*",
  });
  expect(webhookRows({ metadata: m })).toEqual([]);
});
