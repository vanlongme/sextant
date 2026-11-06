import { expect, test } from "vitest";
import { dataChanges, dataOf, isValidDataKey, keyCount } from "./dataEdits";

test("only what changed is sent", () => {
  expect(
    dataChanges({ a: "1", b: "2", c: "3" }, { a: "1", b: "9", d: "4" }),
  ).toEqual([
    { key: "b", value: "9" },
    { key: "c", value: null },
    { key: "d", value: "4" },
  ]);
  expect(dataChanges({ a: "1" }, { a: "1" })).toEqual([]);
});

test("a data key is what the API allows", () => {
  for (const good of ["a", "a.b", "a-b_c", "A1"])
    expect(isValidDataKey(good)).toBe(true);
  for (const bad of ["", "a b", "a/b", "é", "x".repeat(254)])
    expect(isValidDataKey(bad)).toBe(false);
});

test("a key named like an object member is an ordinary key", () => {
  expect(
    dataChanges({}, { constructor: "x" } as Record<string, string>),
  ).toEqual([{ key: "constructor", value: "x" }]);
  expect(dataChanges({ toString: "x" } as Record<string, string>, {})).toEqual([
    { key: "toString", value: null },
  ]);
});

test("anything but a map of strings reads as no data", () => {
  expect(dataOf(undefined)).toEqual({});
  expect(dataOf("text")).toEqual({});
  expect(dataOf(["a"])).toEqual({});
  expect(dataOf({ a: "1", b: 2 })).toEqual({ a: "1" });
  expect(keyCount({ a: "1", b: "" })).toBe(2);
  expect(keyCount(null)).toBe(0);
});
