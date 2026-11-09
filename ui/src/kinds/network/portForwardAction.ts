import { ArrowRightLeft } from "lucide-react";
import { createElement } from "react";
import { PortForwardDialog } from "../../features/portForward/PortForwardDialog";
import type { PortForwardKind } from "../../ipc/generated/PortForwardKind";
import type { KindAction } from "../registry";

/*
 * No `requires`: the app has no access review command, so a Forbidden shows
 * when Start is pressed (spec §2).
 */
function forwardAction(kind: PortForwardKind): KindAction {
  return {
    id: "portForward",
    label: "Port forward",
    icon: ArrowRightLeft,
    ...(kind === "service" ? { top: true } : {}),
    run: (ctx, o) => {
      ctx.dialog((close) =>
        createElement(PortForwardDialog, {
          clusterId: ctx.clusterId,
          kind,
          object: o,
          close,
        }),
      );
    },
  };
}

/** On Pods, after Attach (spec §5.1). */
export const portForwardAction: KindAction = forwardAction("pod");

/** On Services, their only action, also a header button. */
export const servicePortForwardAction: KindAction = forwardAction("service");
