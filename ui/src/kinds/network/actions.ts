import { Star } from "lucide-react";
import { toast } from "../../design";
import { api } from "../../ipc/api";
import type { KindAction } from "../registry";
import { isDefaultIngressClass } from "./network";

/**
 * Makes this IngressClass the cluster default and clears the flag on the others. A
 * partial failure rejects with the classes left unchanged, and `runAction` shows it.
 */
export const setDefaultAction: KindAction = {
  id: "set-default",
  label: "Set as default",
  icon: Star,
  requires: "patch",
  visible: (o) => !isDefaultIngressClass(o),
  run: async (ctx, o) => {
    await api.ingressClassSetDefault(ctx.clusterId, o.metadata.name);
    toast.success(`${o.metadata.name} is now the default IngressClass`);
  },
};
