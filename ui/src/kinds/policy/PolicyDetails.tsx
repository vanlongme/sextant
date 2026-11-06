import { Chips, Facts, ObjectLink, Part, SimpleTable } from "../detail/parts";
import type { DetailProps } from "../registry";
import { selectorText } from "../selectors";
import { hpaMetrics, limitRows, quotaRows, webhookRows } from "./policy";

function chips(values: string[]) {
  return values.length > 0 ? <Chips values={values} /> : undefined;
}

export function HorizontalPodAutoscalerDetail({
  clusterId,
  object,
  resources,
}: DetailProps) {
  const spec = object.spec ?? {};
  const status = object.status ?? {};
  const target = spec.scaleTargetRef;
  const targetLink = target?.name ? (
    <ObjectLink
      clusterId={clusterId}
      resources={resources}
      kind={target.kind}
      name={target.name}
      namespace={object.metadata.namespace}
      apiVersion={target.apiVersion}
    />
  ) : undefined;
  return (
    <>
      <Part title="Autoscaler">
        <Facts
          items={[
            ["Target", targetLink],
            ["Min replicas", String(spec.minReplicas ?? 1)],
            ["Max replicas", spec.maxReplicas],
            ["Current replicas", String(status.currentReplicas ?? 0)],
            ["Desired replicas", String(status.desiredReplicas ?? 0)],
          ]}
        />
      </Part>
      <Part title="Metrics">
        <SimpleTable
          testId="detail-hpa-metrics"
          headers={["Metric", "On", "Current", "Target"]}
          rows={hpaMetrics(object).map((m) => [
            m.name,
            m.on,
            m.current,
            m.target,
          ])}
          empty="No metrics."
        />
      </Part>
    </>
  );
}

export function PodDisruptionBudgetDetail({ object }: DetailProps) {
  const spec = object.spec ?? {};
  const status = object.status ?? {};
  const selector = selectorText(spec.selector);
  return (
    <Part title="Pod disruption budget">
      <Facts
        items={[
          ["Min available", spec.minAvailable],
          ["Max unavailable", spec.maxUnavailable],
          ["Selector", chips(selector)],
          ["Current healthy", String(status.currentHealthy ?? 0)],
          ["Desired healthy", String(status.desiredHealthy ?? 0)],
          ["Allowed disruptions", String(status.disruptionsAllowed ?? 0)],
          ["Expected pods", String(status.expectedPods ?? 0)],
        ]}
      />
    </Part>
  );
}

export function ResourceQuotaDetail({ object }: DetailProps) {
  const scopes: string[] = Array.isArray(object.spec?.scopes)
    ? object.spec.scopes
    : [];
  return (
    <>
      <Part title="Resource quota">
        <Facts items={[["Scopes", chips(scopes)]]} />
      </Part>
      <Part title="Usage">
        <SimpleTable
          testId="detail-quota"
          headers={["Resource", "Used", "Hard"]}
          rows={quotaRows(object).map((r) => [r.resource, r.used, r.hard])}
          empty="No quota set."
        />
      </Part>
    </>
  );
}

export function LimitRangeDetail({ object }: DetailProps) {
  return (
    <Part title="Limits">
      <SimpleTable
        testId="detail-limits"
        headers={[
          "Type",
          "Resource",
          "Min",
          "Max",
          "Default request",
          "Default limit",
          "Max ratio",
        ]}
        rows={limitRows(object).map((r) => [
          r.type,
          r.resource,
          r.min || "-",
          r.max || "-",
          r.defaultRequest || "-",
          r.defaultLimit || "-",
          r.ratio || "-",
        ])}
        empty="No limits."
      />
    </Part>
  );
}

export function PriorityClassDetail({ object }: DetailProps) {
  return (
    <Part title="Priority class">
      <Facts
        items={[
          [
            "Value",
            object.value === undefined ? undefined : String(object.value),
          ],
          ["Global default", object.globalDefault ? "Yes" : "No"],
          ["Preemption policy", object.preemptionPolicy],
          ["Description", object.description],
        ]}
      />
    </Part>
  );
}

export function RuntimeClassDetail({ object }: DetailProps) {
  return (
    <Part title="Runtime class">
      <Facts items={[["Handler", object.handler]]} />
    </Part>
  );
}

export function LeaseDetail({ object }: DetailProps) {
  const spec = object.spec ?? {};
  return (
    <Part title="Lease">
      <Facts
        items={[
          ["Holder", spec.holderIdentity],
          [
            "Duration",
            spec.leaseDurationSeconds === undefined
              ? undefined
              : `${spec.leaseDurationSeconds}s`,
          ],
          [
            "Transitions",
            spec.leaseTransitions === undefined
              ? undefined
              : String(spec.leaseTransitions),
          ],
          ["Acquired", spec.acquireTime],
          ["Renewed", spec.renewTime],
        ]}
      />
    </Part>
  );
}

export function WebhookConfigurationDetail({ object }: DetailProps) {
  const webhooks = webhookRows(object);
  if (webhooks.length === 0) {
    return (
      <Part title="Webhooks">
        <p>No webhooks.</p>
      </Part>
    );
  }
  return (
    <>
      {webhooks.map((w, index) => (
        <Part
          // biome-ignore lint/suspicious/noArrayIndexKey: webhook names may repeat
          key={`${index}:${w.name}`}
          title={`Webhook ${w.name}`}
          testId="detail-webhook"
        >
          <Facts
            items={[
              ["Client", w.client],
              ["Failure policy", w.failurePolicy],
              ["Match policy", w.matchPolicy],
              ["Side effects", w.sideEffects],
              ["Timeout", w.timeout],
              ["Namespace selector", chips(w.namespaceSelector)],
              ["Object selector", chips(w.objectSelector)],
            ]}
          />
          <SimpleTable
            headers={[
              "Operations",
              "API groups",
              "API versions",
              "Resources",
              "Scope",
            ]}
            rows={w.rules.map((r) => [
              r.operations,
              r.apiGroups || '""',
              r.apiVersions,
              r.resources,
              r.scope,
            ])}
            empty="No rules."
          />
        </Part>
      ))}
    </>
  );
}
