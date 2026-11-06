import { toast } from "../../design";
import { api } from "../../ipc/api";
import {
  baseColumns,
  numberColumn,
  statusColumn,
  textColumn,
} from "../columns";
import { registerKind } from "../registry";
import { PodDetail } from "./PodDetail";
import { podStatus, podSummary } from "./pod";

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
    {
      id: "evict",
      label: "Evict",
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
  ],
  detail: PodDetail,
});
