import type { ReactElement } from "react";
import { expect, test } from "vitest";
import type { Tone } from "../../design/Badge";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import "../../kinds/workloads";
import type { KubeObject } from "../../kinds/objects";
import { kindSpec } from "../../kinds/registry";
import type { ResourceListState } from "../../stores/resources";
import {
  inNamespaces,
  kindRow,
  latestEvents,
  WORKLOAD_KINDS,
  workloadCounts,
} from "./counts";

const object = (name: string, namespace = "default"): KubeObject => ({
  metadata: { name, namespace },
});

/** A status that reads the tone from the object's name. */
const byName = {
  status: (o: KubeObject) => ({ label: "x", tone: o.metadata.name as Tone }),
};

test("ok is healthy, info and warn are pending, danger is failing", () => {
  const objects = ["ok", "ok", "info", "warn", "danger"].map((n) => object(n));
  expect(workloadCounts(byName, objects)).toEqual({
    total: 5,
    healthy: 2,
    pending: 2,
    failing: 1,
  });
});

test("neutral objects count only in Total", () => {
  const objects = ["neutral", "neutral", "ok"].map((n) => object(n));
  expect(workloadCounts(byName, objects)).toEqual({
    total: 3,
    healthy: 1,
    pending: 0,
    failing: 0,
  });
  expect(workloadCounts(byName, [])).toEqual({
    total: 0,
    healthy: 0,
    pending: 0,
    failing: 0,
  });
});

test("the kinds are the Workloads section's, in its order", () => {
  expect(WORKLOAD_KINDS.map((k) => k.label)).toEqual([
    "Pods",
    "Deployments",
    "DaemonSets",
    "StatefulSets",
    "ReplicaSets",
    "Jobs",
    "CronJobs",
  ]);
});

// Objects that land in every bucket of at least one kind.
const SAMPLES: KubeObject[] = [
  { metadata: { name: "a" } },
  { metadata: { name: "b", deletionTimestamp: "2026-01-01T00:00:00Z" } },
  {
    metadata: { name: "c" },
    spec: { replicas: 2, suspend: true },
    status: {
      phase: "Running",
      readyReplicas: 2,
      updatedReplicas: 2,
      desiredNumberScheduled: 2,
      numberReady: 2,
      conditions: [
        { type: "Available", status: "True" },
        { type: "Complete", status: "True" },
      ],
      containerStatuses: [{ name: "app", ready: true, state: { running: {} } }],
    },
  },
  {
    metadata: { name: "d" },
    spec: { replicas: 0 },
    status: {
      phase: "Pending",
      conditions: [{ type: "Failed", status: "True" }],
      containerStatuses: [
        {
          name: "app",
          ready: false,
          state: { waiting: { reason: "CrashLoopBackOff" } },
        },
      ],
    },
  },
  {
    metadata: { name: "e" },
    spec: { replicas: 3 },
    status: {
      readyReplicas: 1,
      desiredNumberScheduled: 3,
      numberReady: 1,
      conditions: [{ type: "ReplicaFailure", status: "True" }],
    },
  },
];

const INFO = { resource: { namespaced: true } } as ApiResourceInfo;

test.each(WORKLOAD_KINDS.map((k) => [k.label, k] as const))(
  "%s are counted with the status their list shows",
  (_label, kind) => {
    const columns = kindSpec(kind.group, kind.plural)?.columns?.(INFO) ?? [];
    const column = columns.find((c) => c.id === "status");
    expect(column).toBeDefined();
    for (const o of SAMPLES) {
      const shown = column?.render(o) as ReactElement<{
        tone: Tone;
        children: string;
      }>;
      expect(kind.status(o)).toEqual({
        label: shown.props.children,
        tone: shown.props.tone,
      });
    }
  },
);

test("an empty selection is every namespace", () => {
  const objects = [object("a", "one"), object("b", "two"), object("c", "")];
  const names = (list: KubeObject[]) => list.map((o) => o.metadata.name);
  expect(names(inNamespaces(objects, []))).toEqual(["a", "b", "c"]);
  expect(names(inNamespaces(objects, ["two", "three"]))).toEqual(["b"]);
});

const PODS = WORKLOAD_KINDS[0];
const served = (over: Partial<ApiResourceInfo> = {}): ApiResourceInfo => ({
  resource: {
    group: "",
    version: "v1",
    plural: "pods",
    kind: "Pod",
    namespaced: true,
  },
  verbs: ["list", "watch"],
  shortNames: [],
  canList: true,
  canWatch: true,
  canCreate: false,
  canUpdate: false,
  canPatch: false,
  canDelete: false,
  ...over,
});
const list = (over: Partial<ResourceListState> = {}): ResourceListState => ({
  items: [],
  status: "live",
  message: null,
  loading: false,
  ...over,
});
const discovered = { loading: false, error: null };

test("a kind waits for discovery, then for its first list", () => {
  expect(
    kindRow(PODS, undefined, { loading: true, error: null }, list(), []),
  ).toEqual({ kind: PODS, state: "loading" });
  expect(
    kindRow(PODS, served(), discovered, list({ loading: true }), []),
  ).toEqual({ kind: PODS, state: "loading" });
});

test("a kind is counted in the chosen namespaces", () => {
  const items = [object("ok", "one"), object("danger", "two")];
  const row = kindRow(
    { ...PODS, status: byName.status },
    served(),
    discovered,
    list({ items }),
    ["two"],
  );
  expect(row).toMatchObject({
    state: "counted",
    counts: { total: 1, healthy: 0, pending: 0, failing: 1 },
  });
});

test("a kind the cluster does not serve or the user may not list has no counts", () => {
  expect(kindRow(PODS, undefined, discovered, list(), [])).toEqual({
    kind: PODS,
    state: "unavailable",
    reason: "This cluster does not serve Pods.",
  });
  expect(
    kindRow(PODS, undefined, { loading: false, error: "boom" }, list(), []),
  ).toEqual({ kind: PODS, state: "unavailable", reason: "boom" });
  expect(
    kindRow(PODS, served({ canList: false }), discovered, list(), []),
  ).toEqual({
    kind: PODS,
    state: "unavailable",
    reason: "You may not list Pods.",
  });
  expect(
    kindRow(
      PODS,
      served(),
      discovered,
      list({ status: "forbidden", message: "pods is forbidden" }),
      [],
    ),
  ).toEqual({ kind: PODS, state: "unavailable", reason: "pods is forbidden" });
  expect(
    kindRow(PODS, served(), discovered, list({ status: "notServed" }), []),
  ).toEqual({
    kind: PODS,
    state: "unavailable",
    reason: "This cluster does not serve Pods.",
  });
});

const event = (
  name: string,
  seen: string | undefined,
  namespace = "default",
): KubeObject => ({
  metadata: { name, namespace },
  lastTimestamp: seen,
});

test("the latest events come newest first, at most `limit`", () => {
  const events = [
    event("old", "2026-11-14T10:00:00Z"),
    event("timeless", undefined),
    event("newest", "2026-11-14T12:00:00Z"),
    event("middle", "2026-11-14T11:00:00Z"),
  ];
  const names = (list: KubeObject[]) => list.map((o) => o.metadata.name);
  expect(names(latestEvents(events, 10))).toEqual([
    "newest",
    "middle",
    "old",
    "timeless",
  ]);
  expect(names(latestEvents(events, 2))).toEqual(["newest", "middle"]);
});
