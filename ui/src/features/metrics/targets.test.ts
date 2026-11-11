import { describe, expect, test } from "vitest";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import type { KubeObject } from "../../kinds/objects";
import { DEPLOYMENTS, JOBS, NODES, PODS } from "../../kinds/refs";
import { T0 } from "../../test/metrics";
import { NO_FACTS } from "./charts";
import { clockTime, dayLabel } from "./format";
import {
  drawerFacts,
  metricsTargetOf,
  objectEmptyText,
  usageSourceOf,
} from "./targets";

function ref(
  group: string,
  plural: string,
  kind: string,
  namespaced = true,
): ResourceRef {
  return { group, version: "v1", plural, kind, namespaced };
}

const STATEFULSETS = ref("apps", "statefulsets", "StatefulSet");
const DAEMONSETS = ref("apps", "daemonsets", "DaemonSet");
const REPLICASETS = ref("apps", "replicasets", "ReplicaSet");
const PVCS = ref("", "persistentvolumeclaims", "PersistentVolumeClaim");
const CONFIGMAPS = ref("", "configmaps", "ConfigMap");
const CUSTOM_PODS = ref("example.com", "pods", "Pod");

/** The time the tests read as now: an hour after the fixture series start. */
const NOW = T0 + 3600;
const iso = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString();

function obj(
  name: string,
  namespace: string | undefined,
  status?: Record<string, unknown>,
): KubeObject {
  return { metadata: { name, namespace }, ...(status ? { status } : {}) };
}

const running = (startedAgo = 600) =>
  obj("web", "shop", {
    phase: "Running",
    startTime: iso(NOW - startedAgo),
    containerStatuses: [{ name: "main", state: { running: {} } }],
  });

const ended = (phase: "Succeeded" | "Failed", ...finished: number[]) =>
  obj("web", "shop", {
    phase,
    startTime: iso(T0 - 7200),
    containerStatuses: finished.map((t, i) => ({
      name: `c${i}`,
      state: { terminated: { finishedAt: iso(t) } },
    })),
  });

describe("metricsTargetOf", () => {
  test.each([
    ["Node", NODES, obj("w1", undefined), { kind: "node", name: "w1" }],
    [
      "Pod",
      PODS,
      obj("web", "shop"),
      { kind: "pod", namespace: "shop", name: "web" },
    ],
    [
      "Deployment",
      DEPLOYMENTS,
      obj("web", "shop"),
      {
        kind: "workload",
        namespace: "shop",
        name: "web",
        workloadKind: "Deployment",
      },
    ],
    [
      "StatefulSet",
      STATEFULSETS,
      obj("db", "shop"),
      {
        kind: "workload",
        namespace: "shop",
        name: "db",
        workloadKind: "StatefulSet",
      },
    ],
    [
      "DaemonSet",
      DAEMONSETS,
      obj("agent", "kube-system"),
      {
        kind: "workload",
        namespace: "kube-system",
        name: "agent",
        workloadKind: "DaemonSet",
      },
    ],
    [
      "ReplicaSet",
      REPLICASETS,
      obj("web-1", "shop"),
      {
        kind: "workload",
        namespace: "shop",
        name: "web-1",
        workloadKind: "ReplicaSet",
      },
    ],
    [
      "PersistentVolumeClaim",
      PVCS,
      obj("data", "shop"),
      { kind: "pvc", namespace: "shop", name: "data" },
    ],
  ])("a %s gives its target", (_label, resource, object, target) => {
    expect(metricsTargetOf(resource, object)).toEqual(target);
  });

  test("a Job, a ConfigMap and a custom kind named pods have no target", () => {
    expect(metricsTargetOf(JOBS, obj("migrate", "shop"))).toBeNull();
    expect(metricsTargetOf(CONFIGMAPS, obj("conf", "shop"))).toBeNull();
    expect(metricsTargetOf(CUSTOM_PODS, obj("web", "shop"))).toBeNull();
  });
});

test("usageSourceOf reads nodes by name and Pods by namespace/name", () => {
  expect(usageSourceOf({ kind: "cluster" }, null)).toEqual({
    of: "nodes",
    namespace: null,
    keys: null,
  });
  expect(usageSourceOf({ kind: "node", name: "w1" }, null)).toEqual({
    of: "nodes",
    namespace: null,
    keys: ["w1"],
  });
  expect(
    usageSourceOf({ kind: "pod", namespace: "shop", name: "web" }, null),
  ).toEqual({ of: "pods", namespace: "shop", keys: ["shop/web"] });
  const workload = {
    kind: "workload",
    namespace: "shop",
    name: "web",
    workloadKind: "Deployment",
  } as const;
  expect(usageSourceOf(workload, ["shop/web-1", "shop/web-2"])).toEqual({
    of: "pods",
    namespace: "shop",
    keys: ["shop/web-1", "shop/web-2"],
  });
  expect(usageSourceOf(workload, null)).toEqual({
    of: "pods",
    namespace: "shop",
    keys: [],
  });
  expect(
    usageSourceOf({ kind: "pvc", namespace: "shop", name: "data" }, null),
  ).toBeNull();
});

describe("drawerFacts", () => {
  const deployment = {
    kind: "workload",
    namespace: "shop",
    name: "web",
    workloadKind: "Deployment",
  } as const;

  test("a node gives its allocatable CPU and memory", () => {
    const node = obj("w1", undefined, {
      allocatable: { cpu: "3500m", memory: "16Gi" },
    });
    expect(
      drawerFacts({ kind: "node", name: "w1" }, node, "prometheus", null),
    ).toEqual({
      ...NO_FACTS,
      allocatableCores: 3.5,
      allocatableBytes: 16 * 2 ** 30,
    });
  });

  test("a workload counts its replicas, or its matching Pods under metrics-server", () => {
    const count = (
      object: KubeObject,
      source: "prometheus" | "metricsServer",
    ) => drawerFacts(deployment, object, source, 5).podCount;
    expect(count(obj("web", "shop", { replicas: 3 }), "prometheus")).toBe(3);
    // Kubernetes leaves a zero count out of the status.
    expect(count(obj("web", "shop", {}), "prometheus")).toBe(0);
    expect(count(obj("web", "shop"), "prometheus")).toBeNull();
    expect(count(obj("web", "shop", { replicas: 3 }), "metricsServer")).toBe(5);
    const daemonSet = { ...deployment, workloadKind: "DaemonSet" } as const;
    expect(
      drawerFacts(
        daemonSet,
        obj("agent", "shop", { currentNumberScheduled: 2, replicas: 9 }),
        "prometheus",
        null,
      ).podCount,
    ).toBe(2);
  });

  test("a PVC gives its capacity as text, and other targets give nothing", () => {
    const pvc = { kind: "pvc", namespace: "shop", name: "data" } as const;
    expect(
      drawerFacts(
        pvc,
        obj("data", "shop", { capacity: { storage: "10Gi" } }),
        "prometheus",
        null,
      ).capacityText,
    ).toBe("10 GiB");
    expect(
      drawerFacts(pvc, obj("data", "shop", {}), "prometheus", null)
        .capacityText,
    ).toBeNull();
    expect(
      drawerFacts(
        { kind: "pod", namespace: "shop", name: "web" },
        running(),
        "prometheus",
        null,
      ),
    ).toEqual(NO_FACTS);
  });
});

describe("objectEmptyText, in the order of spec §10.4", () => {
  const POD = { kind: "pod", namespace: "shop", name: "web" } as const;
  const podText = (object: KubeObject, rangeStart: number | null = T0) =>
    objectEmptyText(POD, object, "prometheus", rangeStart, null, NOW);

  test("1: a Pending Pod, or one with no running container, has no container yet", () => {
    const pending = obj("web", "shop", {
      phase: "Pending",
      startTime: iso(NOW - 10),
    });
    // Rule 1 wins over rule 2, though this Pod started 10 s ago.
    expect(podText(pending)).toBe(
      "No samples: web has no running container yet (Pending).",
    );
    const waiting = obj("web", "shop", {
      phase: "Running",
      startTime: iso(NOW - 600),
      containerStatuses: [{ name: "main", state: { waiting: {} } }],
    });
    expect(podText(waiting)).toBe(
      "No samples: web has no running container yet (Running).",
    );
    expect(podText(obj("web", "shop"))).toBe(
      "No samples: web has no running container yet (Unknown).",
    );
  });

  test("2: a Pod that started less than 60 s ago", () => {
    expect(podText(running(20))).toBe(
      "No samples yet: the Pod started 20 s ago.",
    );
    expect(podText(running(60))).toBeNull();
  });

  test("3: a finished Pod whose last container ended before the range", () => {
    const last = T0 - 600;
    expect(podText(ended("Succeeded", T0 - 1200, last))).toBe(
      `No samples in this range: web completed ${clockTime(last)} on ${dayLabel(last)}. Pick a longer range.`,
    );
    expect(podText(ended("Failed", T0 - 1200, T0 + 60))).toBeNull();
    // metrics-server has no range to compare with.
    expect(podText(ended("Succeeded", last), null)).toBeNull();
    // A finished Pod skips rule 1, so a Pod that never ran gets no text.
    expect(podText(ended("Failed"))).toBeNull();
  });

  test("4: a workload with no Pods", () => {
    const workload = {
      kind: "workload",
      namespace: "shop",
      name: "web",
      workloadKind: "Deployment",
    } as const;
    const text = (
      object: KubeObject,
      source: "prometheus" | "metricsServer",
      matching: number | null,
    ) => objectEmptyText(workload, object, source, T0, matching, NOW);
    expect(text(obj("web", "shop", {}), "prometheus", null)).toBe(
      "No samples: web has no Pods.",
    );
    expect(text(obj("web", "shop", { replicas: 2 }), "prometheus", null)).toBe(
      null,
    );
    expect(text(obj("web", "shop", { replicas: 2 }), "metricsServer", 0)).toBe(
      "No samples: web has no Pods.",
    );
    // While the Pods load, the shared text stays.
    expect(
      text(obj("web", "shop", { replicas: 2 }), "metricsServer", null),
    ).toBeNull();
  });

  test("5: a PVC that is not Bound", () => {
    const pvc = { kind: "pvc", namespace: "shop", name: "data" } as const;
    const text = (status?: Record<string, unknown>) =>
      objectEmptyText(
        pvc,
        obj("data", "shop", status),
        "prometheus",
        T0,
        null,
        NOW,
      );
    expect(text({ phase: "Pending" })).toBe(
      "No samples: data is Pending, so no node mounts it and kubelet reports no usage.",
    );
    expect(text({ phase: "Lost" })).toBe(
      "No samples: data is Lost, so no node mounts it and kubelet reports no usage.",
    );
    expect(text()).toBe(
      "No samples: data is Pending, so no node mounts it and kubelet reports no usage.",
    );
    expect(text({ phase: "Bound" })).toBeNull();
  });

  test("a node and a running Pod keep the shared text", () => {
    expect(
      objectEmptyText(
        { kind: "node", name: "w1" },
        obj("w1", undefined, {}),
        "prometheus",
        T0,
        null,
        NOW,
      ),
    ).toBeNull();
    expect(podText(running())).toBeNull();
  });
});
