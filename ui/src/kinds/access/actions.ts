import { KeyRound } from "lucide-react";
import { createElement } from "react";
import type { KindAction } from "../registry";
import { KubeconfigDialog } from "./KubeconfigDialog";

// No `requires`: TokenRequest is its own permission, and the API server answers for it.
export const saveKubeconfigAction: KindAction = {
  id: "kubeconfig",
  label: "Save kubeconfig with a token",
  icon: KeyRound,
  run: (ctx, o) =>
    ctx.dialog((close) =>
      createElement(KubeconfigDialog, {
        clusterId: ctx.clusterId,
        object: o,
        close,
      }),
    ),
};
