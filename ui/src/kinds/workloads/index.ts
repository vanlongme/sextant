import { LogOut } from "lucide-react";
import { toast } from "../../design";
import { api } from "../../ipc/api";
import {
  baseColumns,
  numberColumn,
  statusColumn,
  textColumn,
} from "../columns";
import { portForwardAction } from "../network/portForwardAction";
import { type KubeObject, objectKey } from "../objects";
import { registerKind } from "../registry";
import { usageColumns } from "../usageColumns";
import "./jobs";
import { podLogsAction, workloadLogsAction } from "./logsAction";
import {
  PodDetail,
  podRelations,
  podSummaryStats,
  serviceAccountRelations,
} from "./PodDetail";
import { podStatus, podSummary } from "./pod";
import { forceDeleteAction } from "./podActions";
import { RolloutDetail } from "./RolloutDetail";
import {
  daemonSetStatus,
  deploymentStatus,
  desiredReplicas,
  replicaSetStatus,
  restartAction,
  scaleAction,
} from "./rollouts";
import { podAttachAction, podShellAction } from "./sessionActions";
import { claimTemplateItems, templatePodSpec } from "./volumes";

/** The Volumes and Relations of a kind that runs `spec.template` (spec H39). */
const fromTemplate = {
  podSpec: (o: KubeObject) => ({ spec: templatePodSpec(o), podName: null }),
  relations: serviceAccountRelations(templatePodSpec),
};

registerKind("", "pods", {
  columns: (info, usage) =>
    baseColumns(
      info.resource,
      textColumn("ready", "Ready", (o) => podSummary(o).ready, { width: 72 }),
      statusColumn(podStatus),
      numberColumn("restarts", "Restarts", (o) => podSummary(o).restarts),
      textColumn("ip", "IP", (o) => o.status?.podIP, { defaultHidden: true }),
      textColumn("node", "Node", (o) => o.spec?.nodeName),
      ...usageColumns(usage, objectKey),
      textColumn("qos", "QoS", (o) => o.status?.qosClass, {
        defaultHidden: true,
      }),
    ),
  actions: [
    podLogsAction,
    podShellAction,
    podAttachAction,
    portForwardAction,
    {
      id: "evict",
      label: "Evict",
      icon: LogOut,
      danger: true,
      run: async (ctx, o) => {
        const name = o.metadata.name;
        const yes = await ctx.confirm({
          title: `Evict ${name}?`,
          body: "The Eviction API removes the pod and respects PodDisruptionBudgets.",
          confirmLabel: "Evict",
          danger: true,
        });
        if (!yes) return;
        await api.podEvict(ctx.clusterId, o.metadata.namespace ?? "", name);
        toast.success(`Evicting ${name}`);
      },
    },
    forceDeleteAction,
  ],
  detail: PodDetail,
  summary: podSummaryStats,
  relations: podRelations,
  podSpec: (o) => ({ spec: o.spec, podName: o.metadata.name }),
  ownConditions: true,
});

const count = (n: unknown) => (typeof n === "number" ? n : 0);
const readyOver = (o: KubeObject) =>
  `${count(o.status?.readyReplicas)}/${desiredReplicas(o)}`;

registerKind("apps", "deployments", {
  columns: (info) =>
    baseColumns(
      info.resource,
      textColumn("ready", "Ready", readyOver, { width: 72 }),
      statusColumn(deploymentStatus),
      numberColumn("upToDate", "Up-to-date", (o) =>
        count(o.status?.updatedReplicas),
      ),
      numberColumn("available", "Available", (o) =>
        count(o.status?.availableReplicas),
      ),
    ),
  actions: [workloadLogsAction, scaleAction, restartAction],
  detail: RolloutDetail,
  ...fromTemplate,
});

registerKind("apps", "statefulsets", {
  columns: (info) =>
    baseColumns(
      info.resource,
      textColumn("ready", "Ready", readyOver, { width: 72 }),
      statusColumn(replicaSetStatus),
    ),
  actions: [workloadLogsAction, scaleAction, restartAction],
  detail: RolloutDetail,
  podSpec: (o) => ({
    spec: templatePodSpec(o),
    podName: null,
    claimTemplates: claimTemplateItems(o),
  }),
  relations: serviceAccountRelations(templatePodSpec),
});

registerKind("apps", "daemonsets", {
  columns: (info) =>
    baseColumns(
      info.resource,
      numberColumn("desired", "Desired", (o) =>
        count(o.status?.desiredNumberScheduled),
      ),
      numberColumn("current", "Current", (o) =>
        count(o.status?.currentNumberScheduled),
      ),
      numberColumn("ready", "Ready", (o) => count(o.status?.numberReady)),
      statusColumn(daemonSetStatus),
      numberColumn("upToDate", "Up-to-date", (o) =>
        count(o.status?.updatedNumberScheduled),
      ),
      numberColumn("available", "Available", (o) =>
        count(o.status?.numberAvailable),
      ),
      textColumn("nodeSelector", "Node selector", (o) =>
        Object.entries(
          (o.spec?.template?.spec?.nodeSelector ?? {}) as Record<
            string,
            string
          >,
        )
          .map(([k, v]) => `${k}=${v}`)
          .join(","),
      ),
    ),
  actions: [workloadLogsAction, restartAction],
  detail: RolloutDetail,
  ...fromTemplate,
});

registerKind("apps", "replicasets", {
  columns: (info) =>
    baseColumns(
      info.resource,
      numberColumn("desired", "Desired", desiredReplicas),
      numberColumn("current", "Current", (o) => count(o.status?.replicas)),
      numberColumn("ready", "Ready", (o) => count(o.status?.readyReplicas)),
      statusColumn(replicaSetStatus),
    ),
  actions: [workloadLogsAction, scaleAction],
  detail: RolloutDetail,
  ...fromTemplate,
});
