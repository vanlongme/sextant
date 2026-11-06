import { createElement } from "react";
import { toast } from "../../design";
import { api } from "../../ipc/api";
import { baseColumns, statusColumn, textColumn } from "../columns";
import type { KindAction } from "../registry";
import { registerKind } from "../registry";
import { DrainDialog } from "./DrainDialog";
import { NodeDetail } from "./NodeDetail";
import { internalIp, nodeRoles, nodeStatus, nodeTaints } from "./node";

const cordon: KindAction = {
  id: "cordon",
  label: "Cordon",
  requires: "patch",
  visible: (o) => !o.spec?.unschedulable,
  run: async (ctx, o) => {
    await api.nodeSetUnschedulable(ctx.clusterId, o.metadata.name, true);
    toast.success(`Cordoned ${o.metadata.name}`);
  },
};

const uncordon: KindAction = {
  id: "uncordon",
  label: "Uncordon",
  requires: "patch",
  visible: (o) => Boolean(o.spec?.unschedulable),
  run: async (ctx, o) => {
    await api.nodeSetUnschedulable(ctx.clusterId, o.metadata.name, false);
    toast.success(`Uncordoned ${o.metadata.name}`);
  },
};

const drain: KindAction = {
  id: "drain",
  label: "Drain",
  danger: true,
  requires: "patch",
  run: (ctx, o) =>
    ctx.dialog((close) =>
      createElement(DrainDialog, {
        clusterId: ctx.clusterId,
        name: o.metadata.name,
        close,
      }),
    ),
};

registerKind("", "nodes", {
  columns: (info) =>
    baseColumns(
      info.resource,
      statusColumn(nodeStatus),
      textColumn("roles", "Roles", nodeRoles),
      textColumn(
        "version",
        "Version",
        (o) => o.status?.nodeInfo?.kubeletVersion,
      ),
      textColumn("ip", "Internal IP", internalIp),
      {
        id: "taints",
        header: "Taints",
        width: 80,
        sortValue: (o) => nodeTaints(o).length,
        render: (o) => String(nodeTaints(o).length),
      },
    ),
  actions: [cordon, uncordon, drain],
  detail: NodeDetail,
});
