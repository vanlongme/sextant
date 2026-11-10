import { expect, test } from "vitest";
import { fuzzyMatch, isBlank, matchEntry } from "./fuzzy";

function score(query: string, label: string): number {
  return fuzzyMatch(query, label)?.score ?? -1;
}

test("a query matches when its characters appear in order", () => {
  expect(fuzzyMatch("cfg", "ConfigMaps")).not.toBeNull();
  expect(fuzzyMatch("gfc", "ConfigMaps")).toBeNull();
  expect(fuzzyMatch("configmapsx", "ConfigMaps")).toBeNull();
});

test("case is ignored", () => {
  expect(fuzzyMatch("CONFIG", "configmaps")?.ranges).toEqual([[0, 6]]);
});

test("spaces in the query are ignored", () => {
  expect(fuzzyMatch("con fig", "ConfigMaps")).toEqual(
    fuzzyMatch("config", "ConfigMaps"),
  );
});

test("consecutive matches score higher", () => {
  expect(score("abc", "abcxyz")).toBeGreaterThan(score("abc", "axbxcx"));
});

test("matches at word starts score higher", () => {
  expect(score("ser", "my-service")).toBeGreaterThan(
    score("ser", "myxservice"),
  );
  expect(score("m", "configMaps")).toBeGreaterThan(score("m", "configmaps"));
});

test("an earlier first match scores higher", () => {
  expect(score("web", "web-x")).toBeGreaterThan(score("web", "x-web"));
});

test("shorter labels score higher", () => {
  expect(score("pod", "pods")).toBeGreaterThan(score("pod", "podsxx"));
});

test("ranges mark the matched letters of the shortest window", () => {
  expect(fuzzyMatch("cm", "ConfigMaps")?.ranges).toEqual([
    [0, 1],
    [6, 7],
  ]);
  expect(fuzzyMatch("ab", "a-x-ab")?.ranges).toEqual([[4, 6]]);
});

test("the hint matches at half the score, with no highlight", () => {
  const hint = fuzzyMatch("conn", "Connected");
  expect(matchEntry("conn", "alpha", "Connected")).toEqual({
    score: (hint?.score ?? 0) / 2,
    ranges: [],
  });
  expect(matchEntry("conn", "alpha", null)).toBeNull();
  expect(matchEntry("al", "alpha", "Connected")?.ranges).toEqual([[0, 2]]);
});

test("special characters match literally", () => {
  for (const query of ["(", ".*", "[", "\\", "+?", "^$", "|", "*"]) {
    expect(() => fuzzyMatch(query, "web-1")).not.toThrow();
  }
  expect(fuzzyMatch("(", "f(x)")?.ranges).toEqual([[1, 2]]);
  expect(fuzzyMatch("[", "x[y")?.ranges).toEqual([[1, 2]]);
  expect(fuzzyMatch("\\", "a\\b")?.ranges).toEqual([[1, 2]]);
  expect(fuzzyMatch("+?", "a+?b")?.ranges).toEqual([[1, 3]]);
  expect(fuzzyMatch(".*", "a.b")).toBeNull();
  expect(fuzzyMatch(".*", "web-1")).toBeNull();
});

test("a query of spaces is no query", () => {
  expect([isBlank("   "), isBlank(""), isBlank(" a ")]).toEqual([
    true,
    true,
    false,
  ]);
  expect(fuzzyMatch("   ", "anything")).toBeNull();
});
