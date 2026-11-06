import { expect, test } from "vitest";
import { drainReducer, INITIAL_DRAIN } from "./drainState";

const pod = { namespace: "n", name: "a" };

test("a pod moves from waiting through blocked to gone", () => {
  let s = drainReducer(INITIAL_DRAIN, { type: "cordoned" });
  expect(s.cordoned).toBe(true);
  s = drainReducer(s, {
    type: "planned",
    evict: [pod],
    skipped: [{ pod: { namespace: "n", name: "d" }, reason: "daemonSet" }],
  });
  expect(s.pods).toEqual([{ pod, state: "waiting", message: null }]);
  expect(s.skipped).toHaveLength(1);
  s = drainReducer(s, { type: "podEvicting", pod });
  expect(s.pods[0].state).toBe("evicting");
  s = drainReducer(s, { type: "podBlocked", pod, message: "budget" });
  expect(s.pods[0]).toEqual({ pod, state: "blocked", message: "budget" });
  s = drainReducer(s, { type: "podEvicting", pod });
  expect(s.pods[0]).toEqual({ pod, state: "evicting", message: null });
  s = drainReducer(s, { type: "podGone", pod });
  expect(s.pods[0].state).toBe("gone");
  expect(s.outcome).toBeNull();
});

test("a failed pod keeps its message", () => {
  let s = drainReducer(INITIAL_DRAIN, {
    type: "planned",
    evict: [pod],
    skipped: [],
  });
  s = drainReducer(s, { type: "podFailed", pod, message: "denied" });
  expect(s.pods[0]).toEqual({ pod, state: "failed", message: "denied" });
});

test("finished ends the run and keeps its message", () => {
  const s = drainReducer(INITIAL_DRAIN, {
    type: "finished",
    outcome: "refused",
    message: "n/u has no controller",
  });
  expect(s.outcome).toBe("refused");
  expect(s.message).toContain("n/u");
});

test("an event about an unknown pod changes nothing", () => {
  const s = drainReducer(INITIAL_DRAIN, { type: "podGone", pod });
  expect(s).toEqual(INITIAL_DRAIN);
});
