import { createElement } from "react";
import { toast } from "../../design";
import { api } from "../../ipc/api";
import type { StatusInfo } from "../columns";
import type { KubeObject } from "../objects";
import type { KindAction } from "../registry";
import { ScaleDialog } from "./ScaleDialog";

const condition = (o: KubeObject, type: string) =>
  (o.status?.conditions ?? []).find((c: { type: string }) => c.type === type);

export function replicaStatus(
  o: KubeObject,
  desired: number,
  ready: number,
): StatusInfo {
  if (o.metadata.deletionTimestamp)
    return { label: "Terminating", tone: "neutral" };
  if (desired === 0) return { label: "ScaledDown", tone: "neutral" };
  return ready >= desired
    ? { label: "Ready", tone: "ok" }
    : { label: "Updating", tone: "info" };
}

export function deploymentStatus(o: KubeObject): StatusInfo {
  if (o.metadata.deletionTimestamp)
    return { label: "Terminating", tone: "neutral" };
  if (o.spec?.paused) return { label: "Paused", tone: "info" };
  if (condition(o, "ReplicaFailure")?.status === "True")
    return { label: "ReplicaFailure", tone: "danger" };
  const progressing = condition(o, "Progressing");
  if (
    progressing?.status === "False" &&
    progressing.reason === "ProgressDeadlineExceeded"
  )
    return { label: "Stalled", tone: "danger" };
  const desired = o.spec?.replicas ?? 1;
  if (desired === 0) return { label: "ScaledDown", tone: "neutral" };
  const { updatedReplicas = 0, readyReplicas = 0 } = o.status ?? {};
  const done =
    condition(o, "Available")?.status === "True" &&
    updatedReplicas >= desired &&
    readyReplicas >= desired;
  return done
    ? { label: "Available", tone: "ok" }
    : { label: "Updating", tone: "info" };
}

/** The update strategy as one line: its type, then the rolling-update fields that are set. */
export function strategyText(
  // biome-ignore lint/suspicious/noExplicitAny: a strategy is read from an untyped object.
  strategy: any,
): string {
  if (!strategy) return "";
  const parts: string[] = strategy.type ? [String(strategy.type)] : [];
  for (const field of ["maxSurge", "maxUnavailable", "partition"]) {
    const value = strategy.rollingUpdate?.[field];
    if (value !== undefined && value !== null) parts.push(`${field}=${value}`);
  }
  return parts.join(" ");
}

export const scaleAction: KindAction = {
  id: "scale",
  label: "Scale",
  run: (ctx, o) =>
    ctx.dialog((close) =>
      createElement(ScaleDialog, {
        clusterId: ctx.clusterId,
        resource: ctx.resource,
        object: o,
        close,
      }),
    ),
};

export const restartAction: KindAction = {
  id: "restart",
  label: "Restart",
  requires: "patch",
  run: async (ctx, o) => {
    const { name, namespace = "" } = o.metadata;
    const yes = await ctx.confirm({
      title: `Restart ${name}?`,
      body: "Its pods are replaced according to its update strategy.",
      confirmLabel: "Restart",
    });
    if (!yes) return;
    await api.workloadRestart(ctx.clusterId, ctx.resource, namespace, name);
    toast.success(`Restarting ${name}`);
  },
};
