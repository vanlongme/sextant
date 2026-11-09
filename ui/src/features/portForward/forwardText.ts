import type { Tone } from "../../design/Badge";
import type { PortForward } from "../../ipc/generated/PortForward";
import type { PortForwardState } from "../../ipc/generated/PortForwardState";

/** The dot and label of each state (spec §6.2). */
export const STATE_LOOK: Record<
  PortForwardState,
  { tone: Tone; label: string }
> = {
  running: { tone: "ok", label: "Running" },
  starting: { tone: "warn", label: "Starting" },
  failed: { tone: "danger", label: "Failed" },
  stopped: { tone: "neutral", label: "Stopped" },
};

export function kindLabel(f: PortForward): string {
  return f.target.kind === "service" ? "Service" : "Pod";
}

/** `service/web` or `pod/web-1`. */
export function targetText(f: PortForward): string {
  return `${f.target.kind}/${f.target.name}`;
}

/** The target port as the definition has it: a number or a port name. */
export function portText(f: PortForward): string {
  return String(f.targetPort);
}

/** The table's Local column. */
export function localText(f: PortForward): string {
  if (f.boundPort !== null) return `127.0.0.1:${f.boundPort}`;
  if (f.localPort !== null) return `127.0.0.1:${f.localPort}`;
  return "random";
}

/** The drawer's Local address row. */
export function localAddress(f: PortForward): string {
  if (f.boundPort !== null) return `127.0.0.1:${f.boundPort}`;
  if (f.localPort !== null) return `127.0.0.1:${f.localPort} when it runs`;
  return "A random free port when it runs";
}

/** The status bar's count, or null when none runs (spec §6.6). */
export function runningText(count: number): string | null {
  if (count === 0) return null;
  return count === 1
    ? "1 port forward running"
    : `${count} port forwards running`;
}
