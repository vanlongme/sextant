import { expect, test } from "vitest";
import {
  eventCount,
  eventLastSeen,
  eventObjectText,
  eventStatus,
  namespaceStatus,
  preferredVersion,
  printerColumnRows,
} from "./cluster";

const m = { name: "x" };

test("namespace status", () => {
  expect(namespaceStatus({ metadata: m, status: { phase: "Active" } })).toEqual(
    { label: "Active", tone: "ok" },
  );
  expect(
    namespaceStatus({ metadata: m, status: { phase: "Terminating" } }),
  ).toEqual({ label: "Terminating", tone: "neutral" });
  expect(namespaceStatus({ metadata: m })).toEqual({
    label: "Unknown",
    tone: "neutral",
  });
});

test("event reads", () => {
  expect(eventStatus({ metadata: m, type: "Warning" })).toEqual({
    label: "Warning",
    tone: "warn",
  });
  expect(eventStatus({ metadata: m, type: "Normal" })).toEqual({
    label: "Normal",
    tone: "info",
  });
  expect(eventCount({ metadata: m, count: 3 })).toBe(3);
  expect(eventCount({ metadata: m, count: 1, series: { count: 4 } })).toBe(4);
  // A single event in the newer API has no count at all.
  expect(eventCount({ metadata: m })).toBe(1);
  expect(eventCount({ metadata: m, count: 0 })).toBe(1);
  expect(
    eventObjectText({
      metadata: m,
      involvedObject: { kind: "Pod", name: "p" },
    }),
  ).toBe("Pod/p");
  expect(eventObjectText({ metadata: m })).toBe("");
});

test("last seen takes the newest time an event carries", () => {
  expect(
    eventLastSeen({
      metadata: m,
      lastTimestamp: "2026-01-02T00:00:00Z",
      firstTimestamp: "2026-01-01T00:00:00Z",
    }),
  ).toBe("2026-01-02T00:00:00Z");
  expect(
    eventLastSeen({
      metadata: m,
      series: { lastObservedTime: "2026-01-03T00:00:00Z" },
      eventTime: "2026-01-01T00:00:00.000000Z",
    }),
  ).toBe("2026-01-03T00:00:00Z");
  expect(
    eventLastSeen({
      metadata: { ...m, creationTimestamp: "2026-01-01T00:00:00Z" },
    }),
  ).toBe("2026-01-01T00:00:00Z");
  expect(eventLastSeen({ metadata: m })).toBeUndefined();
});

test("the preferred version is the served storage version, else the first served", () => {
  const v = (name: string, served: boolean, storage: boolean) => ({
    name,
    served,
    storage,
  });
  expect(
    preferredVersion({
      metadata: m,
      spec: { versions: [v("a", true, false), v("b", true, true)] },
    })?.name,
  ).toBe("b");
  expect(
    preferredVersion({
      metadata: m,
      spec: { versions: [v("a", true, false), v("b", false, true)] },
    })?.name,
  ).toBe("a");
  expect(preferredVersion({ metadata: m })).toBeUndefined();
});

test("printer column rows", () => {
  expect(
    printerColumnRows({
      name: "v",
      additionalPrinterColumns: [
        {
          name: "Size",
          type: "integer",
          jsonPath: ".spec.size",
          priority: 1,
          description: "d",
        },
      ],
    }),
  ).toEqual([
    {
      name: "Size",
      type: "integer",
      jsonPath: ".spec.size",
      priority: "1",
      description: "d",
    },
  ]);
  expect(printerColumnRows(undefined)).toEqual([]);
});
