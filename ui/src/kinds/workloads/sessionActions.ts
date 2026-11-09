import { Plug, Terminal } from "lucide-react";
import { toast } from "../../design";
import {
  nodeShellImage,
  nodeShellPrompt,
} from "../../features/terminal/nodeShell";
import { reconnect, sessionRunning } from "../../features/terminal/sessions";
import { attachTab, nodeShellTab, shellTab, useDock } from "../../stores/dock";
import type { KindAction } from "../registry";

/*
 * No access check: a missing `pods/exec` or `pods/attach` permission, or a refused
 * node shell Pod, shows as the session's own failure in its tab.
 */

/** A shell in the Pod's default container, or the tab that already has one. */
export const podShellAction: KindAction = {
  id: "shell",
  label: "Shell",
  icon: Terminal,
  top: true,
  run: (ctx, o) => {
    useDock.getState().open(shellTab(ctx.clusterId, o));
  },
};

/** An attach to PID 1 of the Pod's default container, or the tab that has one. */
export const podAttachAction: KindAction = {
  id: "attach",
  label: "Attach",
  icon: Plug,
  run: (ctx, o) => {
    useDock.getState().open(attachTab(ctx.clusterId, o));
  },
};

/** A root shell on the node, after a confirmation (spec §4.2). */
export const nodeShellAction: KindAction = {
  id: "nodeShell",
  label: "Shell",
  icon: Terminal,
  top: true,
  run: async (ctx, o) => {
    if (o.status?.nodeInfo?.operatingSystem === "windows") {
      toast.error("The node shell is not supported on Windows nodes.");
      return;
    }
    const tab = nodeShellTab(ctx.clusterId, o);
    // Opening the same target again focuses its tab.
    if (sessionRunning(tab.id)) {
      useDock.getState().open(tab);
      return;
    }
    const prompt = nodeShellPrompt(
      tab.node,
      await nodeShellImage(ctx.clusterId),
    );
    if (!(await ctx.confirm({ ...prompt, danger: true }))) return;
    useDock.getState().open(tab);
    reconnect(tab);
  },
};
