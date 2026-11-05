import { useCallback, useState } from "react";
import { toast } from "../design";
import { api } from "../ipc/api";
import { failureMessage } from "../ipc/client";
import type { ConnectionState } from "../ipc/generated/ConnectionState";
import { useCatalog } from "./catalog";

const DISCONNECTED: ConnectionState = { status: "disconnected" };

/**
 * The live connection state of a cluster. The catalog store applies each
 * `cluster://state` event, so this follows them without a store of its own.
 */
export function useClusterState(id: string): ConnectionState {
  return useCatalog(
    (s) => s.clusters.find((c) => c.id === id)?.state ?? DISCONNECTED,
  );
}

/** Connect and disconnect for one cluster, with a flag for a call in flight. */
export function useConnect(id: string): {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  busy: boolean;
} {
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (action: "connect" | "disconnect"): Promise<void> => {
      setBusy(true);
      try {
        if (action === "connect") await api.clusterConnect(id);
        else await api.clusterDisconnect(id);
      } catch (error) {
        toast.error(`Could not ${action}`, failureMessage(error));
      } finally {
        setBusy(false);
      }
    },
    [id],
  );

  const connect = useCallback(() => run("connect"), [run]);
  const disconnect = useCallback(() => run("disconnect"), [run]);
  return { connect, disconnect, busy };
}
