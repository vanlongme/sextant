import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ConnectionState } from "./generated/ConnectionState";
import type { PortForward } from "./generated/PortForward";
import type { StoreWarning } from "./generated/StoreWarning";
import type { SyncWarning } from "./generated/SyncWarning";

function on<T>(
  name: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  return listen<T>(name, (event) => handler(event.payload));
}

export const events = {
  onCatalogChanged: (handler: () => void) =>
    on<unknown>("catalog://changed", () => handler()),
  onClusterState: (
    handler: (change: { id: string; state: ConnectionState }) => void,
  ) => on("cluster://state", handler),
  onKubeconfigWarnings: (handler: (warnings: SyncWarning[]) => void) =>
    on("kubeconfig://warnings", handler),
  onStoreWarning: (handler: (warning: StoreWarning) => void) =>
    on("store://warning", handler),
  /** Carries the whole list after every change. */
  onPortForwardsChanged: (handler: (forwards: PortForward[]) => void) =>
    on("portforward://changed", handler),
  /** The macOS menu's app items: `about`, `preferences`, `palette`, `shortcuts`. */
  onMenuCommand: (handler: (command: { id: string }) => void) =>
    on("menu://command", handler),
};
