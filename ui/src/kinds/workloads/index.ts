import { LogOut } from "lucide-react";
import { toast } from "../../design";
import { api } from "../../ipc/api";
import {
  baseColumns,
  numberColumn,
  statusColumn,
  textColumn,
} from "../columns";
import type { KubeObject } from "../objects";
import { registerKind } from "../registry";
import "./jobs";
import { podLogsAction, workloadLogsAction } from "./logsAction";
import { PodDetail } from "./PodDetail";
import { podStatus, podSummary } from "./pod";
import { forceDeleteAction } from "./podActions";
import { RolloutDetail } from "./RolloutDetail";
import {
  deploymentStatus,
  replicaStatus,
  restartAction,
  scaleAction,
} from "./rollouts";

registerKind("", "pods", {
  columns: (info) =>
    baseColumns(
      info.resource,
      textColumn("ready", "Ready", (o) => podSummary(o).ready, { width: 72 }),
      statusColumn(podStatus),
      numberColumn("restarts", "Restarts", (o) => podSummary(o).restarts),
      textColumn("ip", "IP", (o) => o.status?.podIP, { defaultHidden: true }),
      textColumn("node", "Node", (o) => o.spec?.nodeName),
      textColumn("qos", "QoS", (o) => o.status?.qosClass, {
        defaultHidden: true,
      }),
    ),
  actions: [
    podLogsAction,
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
});

const count = (n: unknown) => (typeof n === "number" ? n : 0);
const desiredOf = (o: KubeObject) => count(o.spec?.replicas ?? 1);
const readyOver = (o: KubeObject) =>
  `${count(o.status?.readyReplicas)}/${desiredOf(o)}`;
const replicaSetStatus = (o: KubeObject) =>
  replicaStatus(o, desiredOf(o), count(o.status?.readyReplicas));

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
      statusColumn((o) =>
        replicaStatus(
          o,
          count(o.status?.desiredNumberScheduled),
          count(o.status?.numberReady),
        ),
      ),
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
});

registerKind("apps", "replicasets", {
  columns: (info) =>
    baseColumns(
      info.resource,
      numberColumn("desired", "Desired", desiredOf),
      numberColumn("current", "Current", (o) => count(o.status?.replicas)),
      numberColumn("ready", "Ready", (o) => count(o.status?.readyReplicas)),
      statusColumn(replicaSetStatus),
    ),
  actions: [workloadLogsAction, scaleAction],
  detail: RolloutDetail,
});
