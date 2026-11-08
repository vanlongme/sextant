import { FileCode, type LucideIcon, ShieldOff, Trash2 } from "lucide-react";
import { toast } from "../../design";
import { api } from "../../ipc/api";
import { failureMessage } from "../../ipc/client";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { KubeObject } from "../../kinds/objects";
import type { ActionContext, KindAction } from "../../kinds/registry";

/** One entry of a row menu or of the drawer header, ready to show and run. */
export interface ObjectActionItem {
  id: string;
  label: string;
  icon: LucideIcon;
  danger: boolean;
  disabled: boolean;
  top: boolean;
  run(): void;
}

/** Runs an action. A failure shows "<label> failed" with the API server's message. */
export async function runAction(
  label: string,
  run: () => void | Promise<void>,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    toast.error(`${label} failed`, failureMessage(error));
  }
}

/** Offered for every kind while `metadata.deletionTimestamp` is set. */
export const forceFinalizeAction: KindAction = {
  id: "force-finalize",
  label: "Force finalize",
  icon: ShieldOff,
  danger: true,
  requires: "patch",
  visible: (o) => Boolean(o.metadata.deletionTimestamp),
  run: async (ctx, o) => {
    const { name, namespace } = o.metadata;
    const yes = await ctx.confirm({
      title: `Force finalize ${ctx.resource.kind} ${name}?`,
      body: "This removes every finalizer, so the object goes now. Controllers waiting on them will not clean up what they own.",
      confirmLabel: "Force finalize",
      danger: true,
    });
    if (!yes) return;
    // A cluster-scoped object has no namespace, and the backend wants null for it.
    await api.resourceForceFinalize(
      ctx.clusterId,
      ctx.resource,
      namespace ?? null,
      name,
    );
    toast.success(`Removed the finalizers of ${name}`);
  },
};

function allowed(
  requires: KindAction["requires"],
  info: ApiResourceInfo,
): boolean {
  switch (requires) {
    case "update":
      return info.canUpdate;
    case "patch":
      return info.canPatch;
    case "delete":
      return info.canDelete;
    default:
      return true;
  }
}

/**
 * The actions of one object, in the order every menu shows them: Edit YAML, the
 * kind's own actions, Force finalize, the kind's `placement: "end"` actions, Delete.
 * Hidden actions are left out; actions the user may not run stay, disabled.
 */
export function objectActions(args: {
  object: KubeObject;
  kindActions: KindAction[];
  info: ApiResourceInfo;
  context: ActionContext;
  onDelete(object: KubeObject): void;
}): ObjectActionItem[] {
  const { object, kindActions, info, context, onDelete } = args;
  const edit: KindAction = {
    id: "edit",
    label: "Edit YAML",
    icon: FileCode,
    top: true,
    run: (ctx, o) => ctx.openEditor(o),
  };
  const remove: KindAction = {
    id: "delete",
    label: "Delete",
    icon: Trash2,
    danger: true,
    requires: "delete",
    run: (_ctx, o) => onDelete(o),
  };
  return [
    edit,
    ...kindActions.filter((a) => a.placement !== "end"),
    forceFinalizeAction,
    ...kindActions.filter((a) => a.placement === "end"),
    remove,
  ]
    .filter((a) => a.visible?.(object) ?? true)
    .map((a) => ({
      id: a.id,
      label: a.label,
      icon: a.icon,
      danger: a.danger ?? false,
      disabled: !allowed(a.requires, info),
      top: a.top ?? false,
      run: () => void runAction(a.label, () => a.run(context, object)),
    }));
}
