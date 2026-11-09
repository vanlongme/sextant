import { useMemo } from "react";
import type { KubeObject } from "../../kinds/objects";
import { PODS } from "../../kinds/refs";
import type { PodSessionDockTab } from "../../stores/dock";
import { useResourceList } from "../../stores/resources";

export interface ContainerOption {
  value: string;
  label: string;
}

interface ContainerStatus {
  name: string;
  state?: { waiting?: { reason?: string } };
}

/**
 * The Pod's containers in spec order, a waiting one with its reason, as in
 * "app (CrashLoopBackOff)". Init and ephemeral containers are never offered. Reads
 * only fields a watched Pod row keeps.
 */
export function containerChoices(
  pod: KubeObject | undefined,
): ContainerOption[] {
  if (!pod) return [];
  const statuses: ContainerStatus[] = pod.status?.containerStatuses ?? [];
  return (pod.spec?.containers ?? []).map((c: { name: string }) => {
    const reason = statuses.find((s) => s.name === c.name)?.state?.waiting
      ?.reason;
    return { value: c.name, label: reason ? `${c.name} (${reason})` : c.name };
  });
}

/** The container choices of a Shell or Attach tab, from the live Pod row. */
export function useContainerChoices(
  tab: PodSessionDockTab | null,
): ContainerOption[] {
  const pods = useResourceList(tab?.clusterId ?? "", tab ? PODS : null);
  const namespace = tab?.namespace;
  const name = tab?.pod;
  return useMemo(
    () =>
      containerChoices(
        pods.items.find(
          (p) => p.metadata.namespace === namespace && p.metadata.name === name,
        ),
      ),
    [pods.items, namespace, name],
  );
}
