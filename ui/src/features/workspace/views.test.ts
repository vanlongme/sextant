import { expect, test } from "vitest";
import { wsEvent, wsPod } from "../../test/workspace";
import { podCount, podDrawerPath, podImage, recentEvents } from "./views";

test("recent events are from the last hour, newest first, capped", () => {
  const now = Date.now();
  const items = [
    wsEvent("e1", { minutes: 30 }),
    wsEvent("e2", { minutes: 2, type: "Warning" }),
    wsEvent("e3", { minutes: 61, type: "Warning" }),
    wsEvent("e4", { minutes: 10, type: "Warning" }),
  ];
  const names = (list: typeof items) => list.map((e) => e.metadata.name);

  expect(names(recentEvents(items, now, { limit: 200 }))).toEqual([
    "e2",
    "e4",
    "e1",
  ]);
  expect(names(recentEvents(items, now, { limit: 1 }))).toEqual(["e2"]);
  expect(
    names(recentEvents(items, now, { limit: 20, warnings: true })),
  ).toEqual(["e2", "e4"]);
});

test("an event without a time is left out", () => {
  const timeless = {
    ...wsEvent("e1"),
    lastTimestamp: undefined,
  };
  expect(recentEvents([timeless], Date.now(), { limit: 20 })).toEqual([]);
});

test("a Pod's image is its first container's, plus the others counted", () => {
  expect([
    podImage(wsPod("a", "shop", { images: ["nginx:1.27"] })),
    podImage(wsPod("b", "shop", { images: ["api:2", "sidecar:1", "log:3"] })),
    podImage(wsPod("c", "shop")),
  ]).toEqual(["nginx:1.27", "api:2 +2", ""]);
});

test("the count says pod for one", () => {
  expect([0, 1, 2].map(podCount)).toEqual(["0 pods", "1 pod", "2 pods"]);
});

test("a Pod row opens the Pod's drawer in the full cluster screen", () => {
  expect(podDrawerPath("prod eu", wsPod("web-1", "shop"))).toBe(
    "/cluster/prod%20eu/r/core/pods?object=shop%2Fweb-1",
  );
});
