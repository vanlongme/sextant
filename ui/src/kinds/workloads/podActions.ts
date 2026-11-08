import { Zap } from "lucide-react";
import { toast } from "../../design";
import { api } from "../../ipc/api";
import type { KindAction } from "../registry";

/**
 * Deletes a Pod with a grace period of zero. The uid is a precondition, so a new Pod
 * that has taken the name since is never hit.
 */
export const forceDeleteAction: KindAction = {
  id: "force-delete",
  label: "Force delete",
  icon: Zap,
  danger: true,
  placement: "end",
  requires: "delete",
  run: async (ctx, o) => {
    const { name, namespace = "", uid = "" } = o.metadata;
    const yes = await ctx.confirm({
      title: `Force delete Pod ${name}?`,
      body: "The Pod is removed at once, without waiting for its containers to stop. The node may keep running them until it notices.",
      confirmLabel: "Force delete",
      danger: true,
    });
    if (!yes) return;
    await api.podForceDelete(ctx.clusterId, namespace, name, uid);
    toast.success(`Force deleted ${name}`);
  },
};
