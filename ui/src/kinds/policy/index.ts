import { baseColumns, textColumn } from "../columns";
import { registerKind } from "../registry";
import {
  HorizontalPodAutoscalerDetail,
  LeaseDetail,
  LimitRangeDetail,
  PodDisruptionBudgetDetail,
  PriorityClassDetail,
  ResourceQuotaDetail,
  RuntimeClassDetail,
  WebhookConfigurationDetail,
} from "./PolicyDetails";
import { hpaTargetsText, quotaText, webhookRows } from "./policy";

const webhookColumns = (resource: Parameters<typeof baseColumns>[0]) =>
  baseColumns(
    resource,
    textColumn("webhooks", "Webhooks", (o) => String(webhookRows(o).length)),
  );

registerKind("autoscaling", "horizontalpodautoscalers", {
  columns: (info) =>
    baseColumns(
      info.resource,
      textColumn("reference", "Reference", (o) =>
        o.spec?.scaleTargetRef
          ? `${o.spec.scaleTargetRef.kind}/${o.spec.scaleTargetRef.name}`
          : undefined,
      ),
      textColumn("targets", "Targets", hpaTargetsText),
      textColumn("min", "Min", (o) => String(o.spec?.minReplicas ?? 1)),
      textColumn("max", "Max", (o) => String(o.spec?.maxReplicas ?? "")),
      textColumn("replicas", "Replicas", (o) =>
        String(o.status?.currentReplicas ?? 0),
      ),
    ),
  detail: HorizontalPodAutoscalerDetail,
});

registerKind("policy", "poddisruptionbudgets", {
  columns: (info) =>
    baseColumns(
      info.resource,
      textColumn("minAvailable", "Min available", (o) =>
        o.spec?.minAvailable === undefined
          ? undefined
          : String(o.spec.minAvailable),
      ),
      textColumn("maxUnavailable", "Max unavailable", (o) =>
        o.spec?.maxUnavailable === undefined
          ? undefined
          : String(o.spec.maxUnavailable),
      ),
      textColumn("allowed", "Allowed disruptions", (o) =>
        String(o.status?.disruptionsAllowed ?? 0),
      ),
    ),
  detail: PodDisruptionBudgetDetail,
});

registerKind("", "resourcequotas", {
  columns: (info) =>
    baseColumns(
      info.resource,
      textColumn("request", "Request", (o) => quotaText(o).request),
      textColumn("limit", "Limit", (o) => quotaText(o).limit),
    ),
  detail: ResourceQuotaDetail,
});

registerKind("", "limitranges", {
  columns: (info) =>
    baseColumns(
      info.resource,
      textColumn("types", "Types", (o) =>
        (Array.isArray(o.spec?.limits) ? o.spec.limits : [])
          .map((l: { type?: string }) => l.type)
          .filter(Boolean)
          .join(", "),
      ),
    ),
  detail: LimitRangeDetail,
});

registerKind("scheduling.k8s.io", "priorityclasses", {
  columns: (info) =>
    baseColumns(
      info.resource,
      textColumn("value", "Value", (o) =>
        o.value === undefined ? undefined : String(o.value),
      ),
      textColumn("globalDefault", "Global default", (o) =>
        o.globalDefault ? "Yes" : "-",
      ),
    ),
  detail: PriorityClassDetail,
});

registerKind("node.k8s.io", "runtimeclasses", {
  columns: (info) =>
    baseColumns(
      info.resource,
      textColumn("handler", "Handler", (o) => o.handler),
    ),
  detail: RuntimeClassDetail,
});

registerKind("coordination.k8s.io", "leases", {
  columns: (info) =>
    baseColumns(
      info.resource,
      textColumn("holder", "Holder", (o) => o.spec?.holderIdentity),
    ),
  detail: LeaseDetail,
});

registerKind("admissionregistration.k8s.io", "mutatingwebhookconfigurations", {
  columns: (info) => webhookColumns(info.resource),
  detail: WebhookConfigurationDetail,
});

registerKind(
  "admissionregistration.k8s.io",
  "validatingwebhookconfigurations",
  {
    columns: (info) => webhookColumns(info.resource),
    detail: WebhookConfigurationDetail,
  },
);
