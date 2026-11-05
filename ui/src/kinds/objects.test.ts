import { expect, test } from "vitest";
import { formatAge, objectKey } from "./objects";

const NOW = Date.parse("2026-01-10T12:00:00Z");
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

test("formatAge shows seconds, minutes, hours and days", () => {
  expect(formatAge(ago(59), NOW)).toBe("59s");
  expect(formatAge(ago(5 * 60), NOW)).toBe("5m");
  expect(formatAge(ago(2 * 3600), NOW)).toBe("2h");
  expect(formatAge(ago(3 * 86400), NOW)).toBe("3d");
});

test("formatAge adds the next unit for mixed ages, kubectl style", () => {
  expect(formatAge(ago(2 * 86400 + 3 * 3600), NOW)).toBe("2d3h");
  expect(formatAge(ago(5 * 3600 + 30 * 60), NOW)).toBe("5h30m");
  expect(formatAge(ago(3 * 60 + 20), NOW)).toBe("3m20s");
});

test("formatAge of a missing or unreadable time is a dash", () => {
  expect(formatAge(undefined, NOW)).toBe("-");
  expect(formatAge("not a time", NOW)).toBe("-");
});

test("formatAge of a time in the future is 0s", () => {
  expect(formatAge(ago(-30), NOW)).toBe("0s");
});

test("objectKey joins namespace and name", () => {
  expect(objectKey({ metadata: { name: "web", namespace: "prod" } })).toBe(
    "prod/web",
  );
});

test("objectKey of a cluster-scoped object has an empty namespace", () => {
  expect(objectKey({ metadata: { name: "node-1" } })).toBe("/node-1");
});
