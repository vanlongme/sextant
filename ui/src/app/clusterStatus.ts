import type { Tone } from "../design/Badge";
import type { ConnectionState } from "../ipc/generated/ConnectionState";

const STATUS: Record<ConnectionState["status"], { label: string; tone: Tone }> =
  {
    disconnected: { label: "Disconnected", tone: "neutral" },
    connecting: { label: "Connecting", tone: "info" },
    connected: { label: "Connected", tone: "ok" },
    failed: { label: "Failed", tone: "danger" },
  };

export function clusterStatus(state: ConnectionState): {
  label: string;
  tone: Tone;
} {
  return STATUS[state.status];
}
