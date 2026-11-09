import { useMemo } from "react";
import { type KubeObject, objectKey } from "../../kinds/objects";
import { PODS } from "../../kinds/refs";
import { type LabelSelector, matchesSelector } from "../../kinds/selectors";
import { isPodTab, type LogsDockTab } from "../../stores/dock";
import { useResourceList } from "../../stores/resources";
import { useWholeObject } from "../details/useWholeObject";

export interface ContainerChoice {
  name: string;
  /** Waiting with reason CrashLoopBackOff. */
  crashLooping: boolean;
}

export interface LogSources {
  /** The workload's Pods, by name. Empty for a Pod tab. */
  pods: string[];
  /** The containers that can be read, init containers first. */
  containers: ContainerChoice[];
  /** Whether Previous can be turned on (spec §5.6). */
  previousAllowed: boolean;
  /** Set while the one target Pod is Pending, with the `PodScheduled` message when it is False. */
  pending: { message: string | null } | null;
}

interface ContainerStatus {
  name: string;
  restartCount?: number;
  state?: { waiting?: { reason?: string } };
}

interface PodCondition {
  type: string;
  status: string;
  message?: string;
}

interface ContainerSpecs {
  initContainers?: { name: string }[];
  containers?: { name: string }[];
}

function statusesOf(pod: KubeObject): ContainerStatus[] {
  return [
    ...(pod.status?.initContainerStatuses ?? []),
    ...(pod.status?.containerStatuses ?? []),
  ];
}

function namesOf(spec: ContainerSpecs | undefined): string[] {
  return [...(spec?.initContainers ?? []), ...(spec?.containers ?? [])].map(
    (c) => c.name,
  );
}

/**
 * The live data behind the toolbar's choices. Watched Pod rows keep container names,
 * statuses and the phase, but no condition messages, so a Pending target is fetched
 * whole for its `PodScheduled` message.
 */
export function useLogSources(tab: LogsDockTab): LogSources {
  const podTab = isPodTab(tab);
  const pods = useResourceList(tab.clusterId, PODS);
  const workloads = useResourceList(
    tab.clusterId,
    podTab ? null : tab.resource,
  );
  const workload = podTab
    ? undefined
    : workloads.items.find(
        (o) =>
          o.metadata.namespace === tab.namespace &&
          o.metadata.name === tab.name,
      );
  const selector: LabelSelector | undefined = workload?.spec?.selector;

  const members = useMemo(
    () =>
      podTab
        ? []
        : pods.items.filter(
            (p) =>
              p.metadata.namespace === tab.namespace &&
              matchesSelector(p.metadata.labels, selector),
          ),
    [podTab, pods.items, tab.namespace, selector],
  );

  const targetName = podTab
    ? tab.name
    : tab.options.pod === "all"
      ? null
      : tab.options.pod;
  const target =
    targetName === null
      ? undefined
      : pods.items.find(
          (p) =>
            p.metadata.namespace === tab.namespace &&
            p.metadata.name === targetName,
        );
  const spec: ContainerSpecs | undefined =
    targetName === null ? workload?.spec?.template?.spec : target?.spec;
  const statuses = target ? statusesOf(target) : members.flatMap(statusesOf);
  const chosen = tab.options.container;

  const pendingRow = target?.status?.phase === "Pending" ? target : undefined;
  const whole = useWholeObject(
    tab.clusterId,
    PODS,
    pendingRow ? objectKey(pendingRow) : null,
    pendingRow,
  );
  const conditions: PodCondition[] = whole.object?.status?.conditions ?? [];
  const scheduled = conditions.find((c) => c.type === "PodScheduled");

  return {
    pods: members.map((p) => p.metadata.name).sort(),
    containers: namesOf(spec).map((name) => ({
      name,
      crashLooping: statuses.some(
        (s) =>
          s.name === name && s.state?.waiting?.reason === "CrashLoopBackOff",
      ),
    })),
    previousAllowed:
      target !== undefined &&
      statusesOf(target).some(
        (s) =>
          (chosen === null || s.name === chosen) && (s.restartCount ?? 0) > 0,
      ),
    pending: pendingRow
      ? {
          message:
            scheduled?.status === "False" ? (scheduled.message ?? null) : null,
        }
      : null,
  };
}
