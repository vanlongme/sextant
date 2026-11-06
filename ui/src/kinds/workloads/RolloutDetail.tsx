import { Chips, Facts, Part } from "../detail/parts";
import type { DetailProps } from "../registry";
import { matchesSelector, selectorText } from "../selectors";
import { PodList } from "./PodList";
import { strategyText } from "./rollouts";

function replicasText(
  plural: string,
  // biome-ignore lint/suspicious/noExplicitAny: read from an untyped object.
  o: { spec?: any; status?: any },
): string {
  const spec = o.spec ?? {};
  const status = o.status ?? {};
  if (plural === "daemonsets") {
    return `${status.desiredNumberScheduled ?? 0} desired, ${status.updatedNumberScheduled ?? 0} updated, ${status.numberReady ?? 0} ready, ${status.numberAvailable ?? 0} available`;
  }
  const desired = `${spec.replicas ?? 1} desired`;
  const ready = `${status.readyReplicas ?? 0} ready`;
  if (plural === "replicasets")
    return `${desired}, ${ready}, ${status.availableReplicas ?? 0} available`;
  return `${desired}, ${status.updatedReplicas ?? 0} updated, ${ready}, ${status.availableReplicas ?? 0} available`;
}

export function RolloutDetail({ clusterId, object, resource }: DetailProps) {
  const spec = object.spec ?? {};
  const plural = resource.plural;
  const nodeSelector = Object.entries(
    (spec.template?.spec?.nodeSelector ?? {}) as Record<string, string>,
  ).map(([k, v]) => `${k}=${v}`);
  return (
    <>
      <Part title={resource.kind} testId="detail-rollout">
        <Facts
          items={[
            ["Replicas", replicasText(plural, object)],
            ["Strategy", strategyText(spec.strategy ?? spec.updateStrategy)],
            [
              "Service name",
              plural === "statefulsets" ? spec.serviceName : undefined,
            ],
            [
              "Pod management policy",
              plural === "statefulsets" ? spec.podManagementPolicy : undefined,
            ],
          ]}
        />
        {selectorText(spec.selector).length > 0 ? (
          <Facts
            items={[
              [
                "Selector",
                <Chips key="s" values={selectorText(spec.selector)} />,
              ],
            ]}
          />
        ) : null}
        {plural === "daemonsets" && nodeSelector.length > 0 ? (
          <Facts
            items={[["Node selector", <Chips key="n" values={nodeSelector} />]]}
          />
        ) : null}
      </Part>
      <Part title="Pods">
        <PodList
          clusterId={clusterId}
          namespace={object.metadata.namespace}
          match={(p) => matchesSelector(p.metadata.labels, spec.selector)}
        />
      </Part>
    </>
  );
}
