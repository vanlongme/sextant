import type { MetricsTarget } from "../../ipc/generated/MetricsTarget";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import type { WorkloadKind } from "../../ipc/generated/WorkloadKind";
import type { KubeObject } from "../../kinds/objects";
import { type MetricsSource, NO_FACTS, type TargetFacts } from "./charts";
import { clockTime, dayLabel, formatBytes, parseQuantity } from "./format";
import type { UsageSource } from "./MetricsPanel";

/** The `apps` kinds with charts. Job has none (spec §10.1). */
const WORKLOADS: Record<string, WorkloadKind> = {
  deployments: "Deployment",
  statefulsets: "StatefulSet",
  daemonsets: "DaemonSet",
  replicasets: "ReplicaSet",
};

/** What `metrics_query` reads for an object, or null for a kind without charts. */
export function metricsTargetOf(
  resource: ResourceRef,
  object: KubeObject,
): MetricsTarget | null {
  const { name, namespace } = object.metadata;
  if (resource.group === "") {
    if (resource.plural === "nodes") return { kind: "node", name };
    if (resource.plural === "pods" && namespace) {
      return { kind: "pod", namespace, name };
    }
    if (resource.plural === "persistentvolumeclaims" && namespace) {
      return { kind: "pvc", namespace, name };
    }
    return null;
  }
  if (resource.group === "apps" && namespace) {
    const workloadKind: WorkloadKind | undefined = WORKLOADS[resource.plural];
    if (workloadKind)
      return { kind: "workload", namespace, name, workloadKind };
  }
  return null;
}

/** How a target reads under metrics-server; `podKeys` are a workload's Pods. */
export function usageSourceOf(
  target: MetricsTarget,
  podKeys: string[] | null,
): UsageSource | null {
  switch (target.kind) {
    case "cluster":
      return { of: "nodes", namespace: null, keys: null };
    case "node":
      return { of: "nodes", namespace: null, keys: [target.name] };
    case "pod":
      return {
        of: "pods",
        namespace: target.namespace,
        keys: [`${target.namespace}/${target.name}`],
      };
    case "workload":
      return { of: "pods", namespace: target.namespace, keys: podKeys ?? [] };
    case "pvc":
      return null;
  }
}

/** The replicas a workload reports. Kubernetes leaves a zero count out of `status`. */
function replicasOf(
  workloadKind: WorkloadKind,
  object: KubeObject,
): number | null {
  if (!object.status) return null;
  const value =
    workloadKind === "DaemonSet"
      ? object.status.currentNumberScheduled
      : object.status.replicas;
  return typeof value === "number" ? value : 0;
}

/** The facts an object gives its chart subs (spec §10.3). */
export function drawerFacts(
  target: MetricsTarget,
  object: KubeObject,
  source: MetricsSource,
  matchingPods: number | null,
): TargetFacts {
  switch (target.kind) {
    case "node":
      return {
        ...NO_FACTS,
        allocatableCores: parseQuantity(object.status?.allocatable?.cpu),
        allocatableBytes: parseQuantity(object.status?.allocatable?.memory),
      };
    case "workload":
      return {
        ...NO_FACTS,
        podCount:
          source === "metricsServer"
            ? matchingPods
            : replicasOf(target.workloadKind, object),
      };
    case "pvc": {
      const bytes = parseQuantity(object.status?.capacity?.storage);
      return {
        ...NO_FACTS,
        capacityText: bytes === null ? null : formatBytes(bytes),
      };
    }
    default:
      return NO_FACTS;
  }
}

interface ContainerState {
  running?: unknown;
  terminated?: { finishedAt?: unknown };
}

function containerStates(object: KubeObject): ContainerState[] {
  const list = object.status?.containerStatuses;
  return Array.isArray(list)
    ? list.map((c): ContainerState => c?.state ?? {})
    : [];
}

/** Unix seconds of an RFC 3339 time, or NaN. */
function seconds(time: unknown): number {
  return typeof time === "string" ? Date.parse(time) / 1000 : Number.NaN;
}

function podEmptyText(
  object: KubeObject,
  rangeStart: number | null,
  now: number,
): string | null {
  const name = object.metadata.name;
  const phase: unknown = object.status?.phase;
  const phaseText = typeof phase === "string" ? phase : undefined;
  const finished = phase === "Succeeded" || phase === "Failed";
  const states = containerStates(object);
  if (!finished && (phase === "Pending" || !states.some((s) => s.running))) {
    return `No samples: ${name} has no running container yet (${phaseText ?? "Unknown"}).`;
  }
  const started = seconds(object.status?.startTime);
  if (Number.isFinite(started) && now - started < 60) {
    const ago = Math.max(0, Math.floor(now - started));
    return `No samples yet: the Pod started ${ago} s ago.`;
  }
  if (finished && rangeStart !== null) {
    const ends = states
      .map((s) => seconds(s.terminated?.finishedAt))
      .filter((t) => Number.isFinite(t));
    if (ends.length > 0) {
      const last = Math.max(...ends);
      if (last < rangeStart) {
        return `No samples in this range: ${name} completed ${clockTime(last)} on ${dayLabel(last)}. Pick a longer range.`;
      }
    }
  }
  return null;
}

/**
 * The empty text an object gives its charts (spec §10.4), checked in order, or null
 * to keep the shared one. `rangeStart` is the Prometheus range's start (null under
 * metrics-server), `matchingPods` a workload's Pods under metrics-server (null while
 * they load), `now` unix seconds.
 */
export function objectEmptyText(
  target: MetricsTarget,
  object: KubeObject,
  source: MetricsSource,
  rangeStart: number | null,
  matchingPods: number | null,
  now: number,
): string | null {
  const name = object.metadata.name;
  switch (target.kind) {
    case "pod":
      return podEmptyText(object, rangeStart, now);
    case "workload": {
      const pods =
        source === "metricsServer"
          ? matchingPods
          : replicasOf(target.workloadKind, object);
      return pods === 0 ? `No samples: ${name} has no Pods.` : null;
    }
    case "pvc": {
      const phase: unknown = object.status?.phase;
      if (phase === "Bound") return null;
      const shown = typeof phase === "string" ? phase : "Pending";
      return `No samples: ${name} is ${shown}, so no node mounts it and kubelet reports no usage.`;
    }
    default:
      return null;
  }
}
