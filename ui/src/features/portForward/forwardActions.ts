import {
  ExternalLink,
  type LucideIcon,
  Play,
  RotateCw,
  Square,
  Trash2,
} from "lucide-react";
import { toast } from "../../design";
import { failureMessage } from "../../ipc/client";
import type { PortForward } from "../../ipc/generated/PortForward";
import {
  openInBrowser,
  remove,
  removeMany,
  restart,
  start,
  stop,
} from "./operations";

export type ForwardActionId = "open" | "start" | "stop" | "restart" | "remove";

export interface ForwardAction {
  id: ForwardActionId;
  label: string;
  icon: LucideIcon;
  danger: boolean;
  /** Never rejects: a failure shows as a toast with the backend's message (spec §7). */
  run(): Promise<void>;
}

async function attempt(
  work: () => Promise<unknown>,
  failure: string,
  success?: [string, string],
): Promise<void> {
  try {
    await work();
  } catch (error) {
    toast.error(failure, failureMessage(error));
    return;
  }
  if (success) toast.success(success[0], success[1]);
}

/** A row's actions in menu order, only those its state offers (spec §6.3). */
export function forwardActions(f: PortForward): ForwardAction[] {
  const actions: ForwardAction[] = [];
  if (f.state === "running" && f.boundPort !== null) {
    actions.push({
      id: "open",
      label: "Open in browser",
      icon: ExternalLink,
      danger: false,
      run: () => attempt(() => openInBrowser(f), "Could not open the browser"),
    });
  }
  if (f.state === "stopped" || f.state === "failed") {
    actions.push({
      id: "start",
      label: "Start",
      icon: Play,
      danger: false,
      run: () => attempt(() => start(f.id), "Port forward failed"),
    });
  }
  if (f.state === "running" || f.state === "starting") {
    actions.push({
      id: "stop",
      label: "Stop",
      icon: Square,
      danger: false,
      run: () =>
        attempt(() => stop(f.id), "Could not stop the port forward", [
          "Stopped the port forward",
          "The definition stays; start it again from here",
        ]),
    });
  }
  if (f.state === "running") {
    actions.push({
      id: "restart",
      label: "Restart",
      icon: RotateCw,
      danger: false,
      run: () => attempt(() => restart(f.id), "Port forward failed"),
    });
  }
  actions.push({
    id: "remove",
    label: "Remove",
    icon: Trash2,
    danger: true,
    // Asks nothing: a definition takes a few clicks to make again (spec §6.3).
    run: () =>
      attempt(() => remove(f.id), "Could not remove the port forward", [
        "Removed the port forward",
        "Its definition is deleted",
      ]),
  });
  return actions;
}

/** Removes several: one error toast per failure, then one toast for the rest. Gives the ids that failed. */
export async function removeForwards(ids: string[]): Promise<string[]> {
  const failures = await removeMany(ids);
  for (const failure of failures) {
    toast.error(
      "Could not remove the port forward",
      failureMessage(failure.error),
    );
  }
  const removed = ids.length - failures.length;
  if (removed === 1) {
    toast.success("Removed 1 port forward", "Its definition is deleted");
  } else if (removed > 1) {
    toast.success(
      `Removed ${removed} port forwards`,
      "Their definitions are deleted",
    );
  }
  return failures.map((failure) => failure.id);
}
