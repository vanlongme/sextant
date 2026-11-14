import { expect, test } from "vitest";
import {
  daemonSetStatus,
  deploymentStatus,
  replicaSetStatus,
  replicaStatus,
  strategyText,
} from "./rollouts";

const meta = { name: "d" };
const available = { type: "Available", status: "True" };

test.each([
  [
    "being deleted",
    { metadata: { ...meta, deletionTimestamp: "x" }, spec: { replicas: 1 } },
    "Terminating",
    "neutral",
  ],
  [
    "paused",
    { metadata: meta, spec: { replicas: 1, paused: true } },
    "Paused",
    "info",
  ],
  [
    "replica failure",
    {
      metadata: meta,
      spec: { replicas: 1 },
      status: { conditions: [{ type: "ReplicaFailure", status: "True" }] },
    },
    "ReplicaFailure",
    "danger",
  ],
  [
    "deadline exceeded",
    {
      metadata: meta,
      spec: { replicas: 1 },
      status: {
        conditions: [
          {
            type: "Progressing",
            status: "False",
            reason: "ProgressDeadlineExceeded",
          },
        ],
      },
    },
    "Stalled",
    "danger",
  ],
  [
    "scaled to zero",
    { metadata: meta, spec: { replicas: 0 } },
    "ScaledDown",
    "neutral",
  ],
  [
    "all ready",
    {
      metadata: meta,
      spec: { replicas: 2 },
      status: {
        replicas: 2,
        updatedReplicas: 2,
        readyReplicas: 2,
        conditions: [available],
      },
    },
    "Available",
    "ok",
  ],
  [
    "rolling",
    {
      metadata: meta,
      spec: { replicas: 2 },
      status: {
        replicas: 3,
        updatedReplicas: 1,
        readyReplicas: 2,
        conditions: [available],
      },
    },
    "Updating",
    "info",
  ],
  ["no status yet", { metadata: meta }, "Updating", "info"],
])("deployment %s", (_name, object, label, tone) => {
  expect(deploymentStatus(object)).toEqual({ label, tone });
});

test("replicaStatus compares ready with desired", () => {
  expect(replicaStatus({ metadata: meta }, 2, 2)).toEqual({
    label: "Ready",
    tone: "ok",
  });
  expect(replicaStatus({ metadata: meta }, 2, 1)).toEqual({
    label: "Updating",
    tone: "info",
  });
  expect(replicaStatus({ metadata: meta }, 0, 0)).toEqual({
    label: "ScaledDown",
    tone: "neutral",
  });
  expect(
    replicaStatus({ metadata: { ...meta, deletionTimestamp: "x" } }, 2, 2),
  ).toEqual({ label: "Terminating", tone: "neutral" });
});

test("a ReplicaSet or StatefulSet compares ready replicas with spec.replicas, 1 when unset", () => {
  expect(
    replicaSetStatus({ metadata: meta, status: { readyReplicas: 1 } }),
  ).toEqual({ label: "Ready", tone: "ok" });
  expect(
    replicaSetStatus({
      metadata: meta,
      spec: { replicas: 3 },
      status: { readyReplicas: 2 },
    }),
  ).toEqual({ label: "Updating", tone: "info" });
  expect(replicaSetStatus({ metadata: meta, spec: { replicas: 0 } })).toEqual({
    label: "ScaledDown",
    tone: "neutral",
  });
});

test("a DaemonSet compares ready pods with the nodes it is scheduled on", () => {
  const ds = (desired: number, ready: number) => ({
    metadata: meta,
    status: { desiredNumberScheduled: desired, numberReady: ready },
  });
  expect(daemonSetStatus(ds(3, 3))).toEqual({ label: "Ready", tone: "ok" });
  expect(daemonSetStatus(ds(3, 1))).toEqual({
    label: "Updating",
    tone: "info",
  });
  expect(daemonSetStatus(ds(0, 0))).toEqual({
    label: "ScaledDown",
    tone: "neutral",
  });
});

test("strategyText", () => {
  expect(
    strategyText({
      type: "RollingUpdate",
      rollingUpdate: { maxSurge: "25%", maxUnavailable: 1 },
    }),
  ).toBe("RollingUpdate maxSurge=25% maxUnavailable=1");
  expect(
    strategyText({ type: "RollingUpdate", rollingUpdate: { partition: 2 } }),
  ).toBe("RollingUpdate partition=2");
  expect(strategyText({ type: "Recreate" })).toBe("Recreate");
  expect(strategyText(undefined)).toBe("");
});
