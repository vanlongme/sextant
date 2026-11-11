import { useMemo } from "react";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import { type KubeObject, objectKey } from "../../kinds/objects";
import { PODS } from "../../kinds/refs";
import { useCatalog } from "../../stores/catalog";
import { useResourceList } from "../../stores/resources";
import type { MetricsSource } from "./charts";
import { useProvider } from "./hooks";
import { MetricsPanel } from "./MetricsPanel";
import { workloadPods } from "./rolling";
import {
  drawerFacts,
  metricsTargetOf,
  objectEmptyText,
  usageSourceOf,
} from "./targets";

/**
 * The drawer's Metrics tab: one object's charts. Under metrics-server a workload's
 * chart sums its Pods, which come from the Pod watch while the tab is open.
 */
export function DrawerMetrics(props: {
  clusterId: string;
  resource: ResourceRef;
  object: KubeObject;
}) {
  const { clusterId, resource, object } = props;
  const target = metricsTargetOf(resource, object);
  const kind = useProvider(clusterId)?.value?.kind;
  const source: MetricsSource =
    kind === "metricsServer" ? "metricsServer" : "prometheus";
  const watchPods = target?.kind === "workload" && kind === "metricsServer";
  const pods = useResourceList(clusterId, watchPods ? PODS : null);
  const matching = useMemo(
    () =>
      watchPods && !pods.loading ? workloadPods(object, pods.items) : null,
    [watchPods, pods.loading, pods.items, object],
  );
  const clusterName = useCatalog(
    (s) => s.clusters.find((c) => c.id === clusterId)?.name ?? clusterId,
  );
  if (target === null) return null;

  const matchingPods = matching ? matching.length : null;
  return (
    <MetricsPanel
      clusterId={clusterId}
      clusterName={clusterName}
      target={target}
      facts={drawerFacts(target, object, source, matchingPods)}
      usage={usageSourceOf(target, matching ? matching.map(objectKey) : null)}
      layout="column"
      objectEmpty={(shownSource, rangeStart) =>
        objectEmptyText(
          target,
          object,
          shownSource,
          rangeStart,
          matchingPods,
          Date.now() / 1000,
        )
      }
    />
  );
}
