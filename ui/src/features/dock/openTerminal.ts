import { useCatalog } from "../../stores/catalog";
import { terminalTab, useDock } from "../../stores/dock";

/** Opens the cluster's local terminal, or brings it forward, and shows the dock. */
export function openTerminal(clusterId: string): void {
  const name =
    useCatalog.getState().clusters.find((c) => c.id === clusterId)?.name ??
    null;
  useDock.getState().open(terminalTab(clusterId, name));
}
