import { create } from "zustand";
import { api } from "../ipc/api";
import { failureMessage } from "../ipc/client";
import { events } from "../ipc/events";
import type { PortForward } from "../ipc/generated/PortForward";

export interface PortForwardsState {
  forwards: PortForward[];
  /** True once a list or an event has arrived. */
  loaded: boolean;
  /** Why the last read failed, until a list or an event arrives. */
  error: string | null;
  /** Subscribes to changes, then reads the list. Runs once. */
  load(): Promise<void>;
  /** Reads the list again, as after a failed read. */
  retry(): Promise<void>;
}

const FIRST = {
  forwards: [],
  loaded: false,
  error: null,
} satisfies Partial<PortForwardsState>;

let started: Promise<void> | null = null;
// Every read and every event takes the next number. A read's answer is kept only
// when nothing newer came while it was on its way, since an event is newer.
let seq = 0;

export const usePortForwards = create<PortForwardsState>((set) => {
  async function read(): Promise<void> {
    const mine = ++seq;
    try {
      const forwards = await api.portforwardList();
      if (mine === seq) set({ forwards, loaded: true, error: null });
    } catch (error) {
      if (mine === seq) set({ error: failureMessage(error) });
    }
  }

  return {
    ...FIRST,
    load() {
      if (!started) {
        started = (async () => {
          await events.onPortForwardsChanged((forwards) => {
            seq += 1;
            set({ forwards, loaded: true, error: null });
          });
          await read();
        })();
      }
      return started;
    },
    retry: read,
  };
});

function comparePorts(a: number | string, b: number | string): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

/** The forwards of one cluster, by namespace, then name, then target port. */
export function forwardsOf(
  forwards: PortForward[],
  clusterId: string,
): PortForward[] {
  return forwards
    .filter((f) => f.clusterId === clusterId)
    .sort(
      (a, b) =>
        a.target.namespace.localeCompare(b.target.namespace) ||
        a.target.name.localeCompare(b.target.name) ||
        comparePorts(a.targetPort, b.targetPort),
    );
}

/** The running forwards of every cluster. */
export function runningCount(forwards: PortForward[]): number {
  return forwards.filter((f) => f.state === "running").length;
}

export function resetPortForwardsForTest(): void {
  started = null;
  seq = 0;
  usePortForwards.setState(FIRST);
}
