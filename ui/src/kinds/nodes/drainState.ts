import type { DrainEvent } from "../../ipc/generated/DrainEvent";
import type { DrainOutcome } from "../../ipc/generated/DrainOutcome";
import type { PodRef } from "../../ipc/generated/PodRef";
import type { SkippedPod } from "../../ipc/generated/SkippedPod";

export type PodDrainState =
  | "waiting"
  | "evicting"
  | "blocked"
  | "gone"
  | "failed";

export interface PodProgress {
  pod: PodRef;
  state: PodDrainState;
  message: string | null;
}

export interface DrainState {
  cordoned: boolean;
  pods: PodProgress[];
  skipped: SkippedPod[];
  outcome: DrainOutcome | null;
  message: string | null;
}

export const INITIAL_DRAIN: DrainState = {
  cordoned: false,
  pods: [],
  skipped: [],
  outcome: null,
  message: null,
};

function setPod(
  s: DrainState,
  pod: PodRef,
  state: PodDrainState,
  message: string | null,
): DrainState {
  const same = (p: PodRef) =>
    p.namespace === pod.namespace && p.name === pod.name;
  if (!s.pods.some((p) => same(p.pod))) return s;
  return {
    ...s,
    pods: s.pods.map((p) => (same(p.pod) ? { pod: p.pod, state, message } : p)),
  };
}

export function drainReducer(s: DrainState, e: DrainEvent): DrainState {
  switch (e.type) {
    case "cordoned":
      return { ...s, cordoned: true };
    case "planned":
      return {
        ...s,
        pods: e.evict.map((pod) => ({ pod, state: "waiting", message: null })),
        skipped: e.skipped,
      };
    case "podEvicting":
      return setPod(s, e.pod, "evicting", null);
    case "podBlocked":
      return setPod(s, e.pod, "blocked", e.message);
    case "podGone":
      return setPod(s, e.pod, "gone", null);
    case "podFailed":
      return setPod(s, e.pod, "failed", e.message);
    case "finished":
      return { ...s, outcome: e.outcome, message: e.message };
    default:
      return s;
  }
}
