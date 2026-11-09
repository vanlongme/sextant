import { expect, test } from "vitest";
import { ANSI_BACKGROUND, ANSI_TEXT, overlay, parseAnsi } from "./ansi";

const E = "\u001b";

/** Each segment as [text, color, background]. */
function colors(text: string) {
  return parseAnsi(text).segments.map((s) => [s.text, s.color, s.background]);
}

test("plain text is one plain segment", () => {
  expect(parseAnsi("hello world")).toEqual({
    segments: [
      {
        text: "hello world",
        color: null,
        background: null,
        bold: false,
        dim: false,
        italic: false,
        underline: false,
        mark: null,
      },
    ],
    plain: "hello world",
    hasSgr: false,
  });
  expect(parseAnsi("").segments).toEqual([]);
});

test("the 16 text colors map to tokens, bright ones to the same tokens", () => {
  const tokens = [
    "var(--text-primary)",
    "var(--text-danger)",
    "var(--status-nominal)",
    "var(--status-warning)",
    "var(--border-accent)",
    "var(--border-accent)",
    "var(--border-accent)",
    "var(--text-secondary)",
  ];
  expect(ANSI_TEXT).toEqual(tokens);
  for (let i = 0; i < 8; i += 1) {
    expect(colors(`${E}[${30 + i}mx`)).toEqual([["x", tokens[i], null]]);
    expect(colors(`${E}[${90 + i}mx`)).toEqual([["x", tokens[i], null]]);
  }
});

test("the 16 background colors map to soft tokens", () => {
  const tokens = [
    "var(--status-neutral-soft)",
    "var(--status-critical-soft)",
    "var(--status-nominal-soft)",
    "var(--status-warning-soft)",
    "var(--surface-accent-soft)",
    "var(--surface-accent-soft)",
    "var(--surface-accent-soft)",
    "var(--status-neutral-soft)",
  ];
  expect(ANSI_BACKGROUND).toEqual(tokens);
  for (let i = 0; i < 8; i += 1) {
    expect(colors(`${E}[${40 + i}mx`)).toEqual([["x", null, tokens[i]]]);
    expect(colors(`${E}[${100 + i}mx`)).toEqual([["x", null, tokens[i]]]);
  }
});

test("a red word, then a reset", () => {
  const line = parseAnsi(`${E}[31mred text${E}[0m after`);
  expect(line.plain).toBe("red text after");
  expect(line.hasSgr).toBe(true);
  expect(line.segments.map((s) => [s.text, s.color])).toEqual([
    ["red text", "var(--text-danger)"],
    [" after", null],
  ]);
});

test("39 and 49 reset only their color, and an empty SGR resets everything", () => {
  expect(colors(`${E}[31;42ma${E}[39mb${E}[49mc`)).toEqual([
    ["a", "var(--text-danger)", "var(--status-nominal-soft)"],
    ["b", null, "var(--status-nominal-soft)"],
    ["c", null, null],
  ]);
  expect(colors(`${E}[1;31ma${E}[mb`)).toEqual([
    ["a", "var(--text-danger)", null],
    ["b", null, null],
  ]);
});

test("bold, dim, italic and underline, and their resets", () => {
  const styles = (text: string) =>
    parseAnsi(text).segments.map((s) => [
      s.text,
      s.bold,
      s.dim,
      s.italic,
      s.underline,
    ]);
  expect(styles(`${E}[1ma${E}[2mb${E}[22mc`)).toEqual([
    ["a", true, false, false, false],
    ["b", true, true, false, false],
    ["c", false, false, false, false],
  ]);
  expect(styles(`${E}[3;4ma${E}[23mb${E}[24mc`)).toEqual([
    ["a", false, false, true, true],
    ["b", false, false, false, true],
    ["c", false, false, false, false],
  ]);
});

test("256-color and truecolor codes are read and ignored", () => {
  const styled = (text: string) =>
    parseAnsi(text).segments.map((s) => [
      s.text,
      s.color,
      s.background,
      s.bold,
    ]);
  expect(styled(`${E}[38;5;196;1mx`)).toEqual([["x", null, null, true]]);
  expect(styled(`${E}[48;2;10;20;30;1mx`)).toEqual([["x", null, null, true]]);
  expect(styled(`${E}[38:2::255:0:0mx`)).toEqual([["x", null, null, false]]);
  expect(styled(`${E}[31;38;5;20mx`)).toEqual([
    ["x", "var(--text-danger)", null, false],
  ]);
  expect(parseAnsi(`${E}[38;5;196mx`).hasSgr).toBe(true);
});

test("other escape sequences are removed", () => {
  const plain = (text: string) => parseAnsi(text);
  // CSI that is not SGR: erase line, cursor position.
  expect(plain(`a${E}[2Kb${E}[1;5Hc`)).toMatchObject({
    plain: "abc",
    hasSgr: false,
  });
  // OSC ended by BEL or by ESC \, and one left open.
  expect(plain(`a${E}]0;title\u0007b${E}]8;;http://x${E}\\c`).plain).toBe(
    "abc",
  );
  expect(plain(`a${E}]0;title`).plain).toBe("a");
  // A charset switch and a lone ESC.
  expect(plain(`a${E}(Bb`).plain).toBe("ab");
  expect(plain(`a${E}`).plain).toBe("a");
  // Segments with the same style join up.
  expect(plain(`a${E}[2Kb`).segments.map((s) => s.text)).toEqual(["ab"]);
});

test("markup is only text", () => {
  const line = parseAnsi("<script>alert(1)</script>");
  expect(line.plain).toBe("<script>alert(1)</script>");
  expect(line.segments.map((s) => s.text)).toEqual([
    "<script>alert(1)</script>",
  ]);
});

test("overlay splits segments and patches the given range of the plain text", () => {
  const { segments } = parseAnsi(`ab${E}[31mcdef${E}[0mgh`);
  const marked = overlay(segments, 1, 4, { mark: "match" });
  expect(marked.map((s) => [s.text, s.color, s.mark])).toEqual([
    ["a", null, null],
    ["b", null, "match"],
    ["cd", "var(--text-danger)", "match"],
    ["ef", "var(--text-danger)", null],
    ["gh", null, null],
  ]);
  expect(overlay(segments, 3, 3, { mark: "match" })).toBe(segments);
});
