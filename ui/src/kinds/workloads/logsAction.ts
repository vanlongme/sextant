import { ScrollText } from "lucide-react";
import { logsTab, useDock } from "../../stores/dock";
import type { KindAction } from "../registry";

/**
 * Opens the object's Logs tab, or focuses it. It needs no access check: a missing
 * `pods/log` permission shows as the stream's own Forbidden message.
 */
export const podLogsAction: KindAction = {
  id: "logs",
  label: "Logs",
  icon: ScrollText,
  top: true,
  run: (ctx, o) => {
    useDock.getState().open(logsTab(ctx.clusterId, ctx.resource, o));
  },
};

/** The same, on a workload, reading all of its Pods. */
export const workloadLogsAction: KindAction = {
  ...podLogsAction,
  label: "Logs of all Pods",
};
