import { CircleStop, History, RefreshCw, RotateCcw } from "lucide-react";
import { createElement } from "react";
import { toast } from "../../design";
import { api } from "../../ipc/api";
import type { KindAction } from "../registry";
import { canTerminate, isDeleting } from "./application";
import { nsName } from "./common";
import { RollbackDialog } from "./RollbackDialog";
import { SyncDialog } from "./SyncDialog";

const sync: KindAction = {
  id: "argocd-sync",
  label: "Sync",
  icon: RefreshCw,
  top: true,
  requires: "update",
  visible: (o) => !isDeleting(o),
  run: (ctx, o) =>
    ctx.dialog((close) =>
      createElement(SyncDialog, { clusterId: ctx.clusterId, object: o, close }),
    ),
};

function refresh(hard: boolean): KindAction {
  return {
    id: hard ? "argocd-hard-refresh" : "argocd-refresh",
    label: hard ? "Hard refresh" : "Refresh",
    icon: RotateCcw,
    top: hard ? undefined : true,
    requires: "update",
    run: async (ctx, o) => {
      await api.argocdRefresh(
        ctx.clusterId,
        o.metadata.namespace ?? "",
        o.metadata.name,
        hard,
      );
      toast.success(
        hard ? "Hard refresh requested" : "Refresh requested",
        nsName(o),
      );
    },
  };
}

const terminate: KindAction = {
  id: "argocd-terminate",
  label: "Terminate",
  icon: CircleStop,
  danger: true,
  requires: "update",
  visible: canTerminate,
  run: async (ctx, o) => {
    await api.argocdTerminate(
      ctx.clusterId,
      o.metadata.namespace ?? "",
      o.metadata.name,
    );
    toast.success("Terminate requested", nsName(o));
  },
};

const rollback: KindAction = {
  id: "argocd-rollback",
  label: "Roll back",
  icon: History,
  requires: "update",
  visible: (o) => !isDeleting(o),
  run: (ctx, o) =>
    ctx.dialog((close) =>
      createElement(RollbackDialog, {
        clusterId: ctx.clusterId,
        object: o,
        close,
      }),
    ),
};

/**
 * The Application actions (spec G §8). Each needs `update` on applications. A failure
 * is thrown to the generic action runner, which shows "<Label> failed" with the
 * backend's message.
 */
export const APPLICATION_ACTIONS: KindAction[] = [
  sync,
  refresh(false),
  refresh(true),
  terminate,
  rollback,
];
