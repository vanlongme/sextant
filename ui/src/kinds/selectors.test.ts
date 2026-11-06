import { expect, test } from "vitest";
import { matchesSelector, selectorText } from "./selectors";

test("a missing selector matches nothing and an empty one matches everything", () => {
  expect(matchesSelector({ a: "1" }, undefined)).toBe(false);
  expect(matchesSelector({ a: "1" }, {})).toBe(true);
  expect(matchesSelector(undefined, {})).toBe(true);
});

test("matchLabels and matchExpressions must all hold", () => {
  const selector = {
    matchLabels: { app: "web" },
    matchExpressions: [
      { key: "tier", operator: "In", values: ["a", "b"] },
      { key: "old", operator: "DoesNotExist" },
    ],
  };
  expect(matchesSelector({ app: "web", tier: "a" }, selector)).toBe(true);
  expect(matchesSelector({ app: "web", tier: "c" }, selector)).toBe(false);
  expect(matchesSelector({ app: "web", tier: "a", old: "1" }, selector)).toBe(
    false,
  );
  expect(matchesSelector({ tier: "a" }, selector)).toBe(false);
});

test("NotIn holds for a missing key, and Exists does not", () => {
  expect(
    matchesSelector(
      {},
      { matchExpressions: [{ key: "t", operator: "NotIn", values: ["a"] }] },
    ),
  ).toBe(true);
  expect(
    matchesSelector(
      {},
      { matchExpressions: [{ key: "t", operator: "Exists" }] },
    ),
  ).toBe(false);
});

test("an unknown operator matches nothing", () => {
  expect(
    matchesSelector(
      { t: "a" },
      { matchExpressions: [{ key: "t", operator: "Near" }] },
    ),
  ).toBe(false);
});

test("selectorText reads like kubectl", () => {
  expect(
    selectorText({
      matchLabels: { app: "web" },
      matchExpressions: [
        { key: "tier", operator: "In", values: ["a", "b"] },
        { key: "t", operator: "NotIn", values: ["c"] },
        { key: "x", operator: "Exists" },
        { key: "y", operator: "DoesNotExist" },
      ],
    }),
  ).toEqual(["app=web", "tier in (a, b)", "t notin (c)", "x", "!y"]);
  expect(selectorText(undefined)).toEqual([]);
});
