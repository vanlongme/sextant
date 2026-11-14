import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import { eventLastSeen } from "../../kinds/cluster/cluster";
import type { StatusInfo } from "../../kinds/columns";
import type { KubeObject } from "../../kinds/objects";
import { cronStatus, jobStatus } from "../../kinds/workloads/jobs";
import { podStatus } from "../../kinds/workloads/pod";
import {
  daemonSetStatus,
  deploymentStatus,
  replicaSetStatus,
} from "../../kinds/workloads/rollouts";
import type { ResourceListState } from "../../stores/resources";

/** A kind the Workloads overview counts, with the status its list screen shows. */
export interface WorkloadKind {
  label: string;
  /** The API group; "" is the core group. */
  group: string;
  plural: string;
  status(o: KubeObject): StatusInfo;
}

/** The kinds of the sidebar's Workloads section, in its order. */
export const WORKLOAD_KINDS: readonly WorkloadKind[] = [
  { label: "Pods", group: "", plural: "pods", status: podStatus },
  {
    label: "Deployments",
    group: "apps",
    plural: "deployments",
    status: deploymentStatus,
  },
  {
    label: "DaemonSets",
    group: "apps",
    plural: "daemonsets",
    status: daemonSetStatus,
  },
  {
    label: "StatefulSets",
    group: "apps",
    plural: "statefulsets",
    status: replicaSetStatus,
  },
  {
    label: "ReplicaSets",
    group: "apps",
    plural: "replicasets",
    status: replicaSetStatus,
  },
  { label: "Jobs", group: "batch", plural: "jobs", status: jobStatus },
  { label: "CronJobs", group: "batch", plural: "cronjobs", status: cronStatus },
];

export interface WorkloadCounts {
  total: number;
  healthy: number;
  pending: number;
  failing: number;
}

/**
 * Counts objects by the tone of their status: `ok` is healthy, `info` and `warn`
 * are pending, `danger` is failing. `neutral` (Terminating, ScaledDown, Unknown)
 * counts only in the total.
 */
export function workloadCounts(
  kind: Pick<WorkloadKind, "status">,
  objects: readonly KubeObject[],
): WorkloadCounts {
  const counts = { total: 0, healthy: 0, pending: 0, failing: 0 };
  for (const o of objects) {
    counts.total += 1;
    const { tone } = kind.status(o);
    if (tone === "ok") counts.healthy += 1;
    else if (tone === "info" || tone === "warn") counts.pending += 1;
    else if (tone === "danger") counts.failing += 1;
  }
  return counts;
}

/** The objects in the chosen namespaces; choosing none is All, as in the lists. */
export function inNamespaces(
  objects: readonly KubeObject[],
  namespaces: readonly string[],
): KubeObject[] {
  if (namespaces.length === 0) return [...objects];
  const allowed = new Set(namespaces);
  return objects.filter((o) => allowed.has(o.metadata.namespace ?? ""));
}

/** What discovery says about the cluster's resources. */
export interface Discovery {
  loading: boolean;
  error: string | null;
}

/** The resource to watch: none when the cluster does not serve it or it may not be listed. */
export function listedResource(
  info: ApiResourceInfo | undefined,
): ResourceRef | null {
  return info?.canList ? info.resource : null;
}

/** A watched list as a part of the overview shows it. */
export type ListView =
  | { state: "loading" }
  | { state: "unavailable"; reason: string }
  /** The objects in the chosen namespaces. */
  | { state: "ready"; items: KubeObject[] };

/**
 * Loading until discovery and the first list arrive; unavailable when the cluster
 * does not serve the resource or the user may not list it; else its objects in the
 * chosen namespaces. `label` names the resource in the reasons, as "Pods".
 */
export function listView(
  label: string,
  info: ApiResourceInfo | undefined,
  discovery: Discovery,
  list: ResourceListState,
  namespaces: readonly string[],
): ListView {
  const notServed = `This cluster does not serve ${label}.`;
  const forbidden = `You may not list ${label}.`;
  if (!info) {
    if (discovery.loading) return { state: "loading" };
    return { state: "unavailable", reason: discovery.error ?? notServed };
  }
  if (!info.canList) return { state: "unavailable", reason: forbidden };
  if (list.status === "forbidden" || list.status === "notServed") {
    const fallback = list.status === "forbidden" ? forbidden : notServed;
    return { state: "unavailable", reason: list.message ?? fallback };
  }
  if (list.loading) return { state: "loading" };
  const items = info.resource.namespaced
    ? inNamespaces(list.items, namespaces)
    : list.items;
  return { state: "ready", items };
}

/** A row of the kinds table. */
export type KindRow =
  | { kind: WorkloadKind; state: "loading" }
  | { kind: WorkloadKind; state: "unavailable"; reason: string }
  | { kind: WorkloadKind; state: "counted"; counts: WorkloadCounts };

/** A kind's row: its list as `listView` sees it, counted once it is there. */
export function kindRow(
  kind: WorkloadKind,
  info: ApiResourceInfo | undefined,
  discovery: Discovery,
  list: ResourceListState,
  namespaces: readonly string[],
): KindRow {
  const view = listView(kind.label, info, discovery, list, namespaces);
  if (view.state !== "ready") return { kind, ...view };
  return { kind, state: "counted", counts: workloadCounts(kind, view.items) };
}

/**
 * The newest events first, at most `limit`. An event without a time it was seen
 * comes last.
 */
export function latestEvents(
  events: readonly KubeObject[],
  limit: number,
): KubeObject[] {
  const seen = (e: KubeObject) => {
    const at = Date.parse(eventLastSeen(e) ?? "");
    return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
  };
  return events
    .map((e) => ({ e, at: seen(e) }))
    .sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? 1 : -1))
    .slice(0, limit)
    .map(({ e }) => e);
}
