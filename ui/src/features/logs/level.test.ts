import { expect, test } from "vitest";
import { parseAnsi } from "./ansi";
import { detectLevel, LEVEL_COLORS } from "./level";

test("each level has its token", () => {
  expect(LEVEL_COLORS).toEqual({
    info: "var(--text-secondary)",
    warn: "var(--status-warning)",
    error: "var(--text-danger)",
  });
});

test.each<[string, string, number, number]>([
  // klog: only the letter.
  ["I1109 10:00:00.000000       1 main.go:10] started", "info", 0, 1],
  ["W1109 10:00:00.000000 slow", "warn", 0, 1],
  ["E1109 10:00:00.000000 failed", "error", 0, 1],
  ["F1109 10:00:00.000000 fatal", "error", 0, 1],
  // JSON: only the word.
  ['{"level":"error","msg":"x"}', "error", 10, 15],
  ['{"level": "INFO"}', "info", 11, 15],
  // logfmt.
  ["ts=1 level=warning msg=x", "warn", 11, 18],
  ["lvl=ERR msg=x", "error", 4, 7],
  ['level="info" msg=x', "info", 7, 11],
  // A leading word, alone or in brackets.
  ["ERROR something failed", "error", 0, 5],
  ["[warn] disk almost full", "warn", 1, 5],
  ["Fatal: boom", "error", 0, 5],
  ["info", "info", 0, 4],
  ["WARNING: low memory", "warn", 0, 7],
])("%s", (line, level, start, end) => {
  expect(detectLevel(line)).toEqual({ level, start, end });
});

test.each<[string]>([
  ["DEBUG starting"],
  ["trace x"],
  ['{"level":"debug","msg":"ERROR x"}'],
  ["[ERROR something"],
  ["ERRORS happen"],
  ["plain text with error later"],
  ["constructor called"],
  [`${"x".repeat(70)} level=error`],
])("%s has no level", (line) => {
  expect(detectLevel(line)).toBeNull();
});

test("the first form found decides", () => {
  expect(detectLevel("I1109 10:00:00 level=error")).toMatchObject({
    level: "info",
  });
});

test("a line with SGR codes is left to its own colors", () => {
  // The view runs detectLevel only when hasSgr is false.
  const line = parseAnsi("\u001b[1mERROR\u001b[0m bold");
  expect(line.hasSgr).toBe(true);
  expect(detectLevel(line.plain)).toMatchObject({ level: "error" });
});
