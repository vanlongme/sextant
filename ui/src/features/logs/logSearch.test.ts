import { expect, test } from "vitest";
import { LogBuffer, type LogEntry } from "./logBuffer";
import { findInEntry, hitsText, SearchIndex, searchPattern } from "./logSearch";

function push(buffer: LogBuffer, text: string): LogEntry {
  return buffer.push({
    kind: "line",
    pod: "web-1",
    container: "app",
    timestamp: null,
    text,
    truncated: false,
  });
}

function bufferOf(texts: string[], capacity?: number): LogBuffer {
  const buffer = new LogBuffer(capacity);
  for (const text of texts) push(buffer, text);
  return buffer;
}

const seqs = (index: SearchIndex) => index.matches.map((m) => m.seq);

test("the query is literal and ignores case", () => {
  expect(searchPattern("")).toBeNull();
  const entry = push(new LogBuffer(), "a.b axb A.B (x)");
  expect(findInEntry(entry, searchPattern("a.b") as RegExp)).toEqual([
    { seq: 0, start: 0, end: 3 },
    { seq: 0, start: 8, end: 11 },
  ]);
  expect(findInEntry(entry, searchPattern("(x)") as RegExp)).toEqual([
    { seq: 0, start: 12, end: 15 },
  ]);
});

test("matches are found in the text without its ANSI codes, and markers have none", () => {
  const buffer = new LogBuffer();
  const line = push(buffer, "\u001b[31mERR\u001b[0mOR here");
  const marker = buffer.push({
    kind: "marker",
    pod: "web-1",
    container: null,
    marker: "restarted",
    message: null,
  });
  expect(findInEntry(line, searchPattern("error") as RegExp)).toEqual([
    { seq: 0, start: 0, end: 5 },
  ]);
  expect(findInEntry(marker, searchPattern("web") as RegExp)).toEqual([]);
});

test("the index finds every match, makes the first current, and steps around", () => {
  const buffer = bufferOf(["alpha", "beta alpha alpha", "gamma"]);
  const index = new SearchIndex();
  expect(index.sync("alpha", buffer)).toBe(true);
  expect(index.matches).toEqual([
    { seq: 0, start: 0, end: 5 },
    { seq: 1, start: 5, end: 10 },
    { seq: 1, start: 11, end: 16 },
  ]);
  expect(index.current).toBe(0);
  index.step(1);
  expect(index.current).toBe(1);
  index.step(1);
  index.step(1);
  expect(index.current).toBe(0);
  index.step(-1);
  expect(index.current).toBe(2);
  expect(index.on(1)).toEqual([
    { seq: 1, start: 5, end: 10 },
    { seq: 1, start: 11, end: 16 },
  ]);
  expect(index.on(2)).toEqual([]);
  expect(index.sync("alpha", buffer)).toBe(false);
});

test("new lines join the matches, and a new query starts at its first match", () => {
  const buffer = bufferOf(["alpha"]);
  const index = new SearchIndex();
  index.sync("alpha", buffer);
  push(buffer, "more alpha");
  index.sync("alpha", buffer);
  expect(seqs(index)).toEqual([0, 1]);

  index.step(1);
  expect(index.sync("more", buffer)).toBe(true);
  expect(index.matches).toEqual([{ seq: 1, start: 0, end: 4 }]);
  expect(index.current).toBe(0);
});

test("a cleared buffer starts the index over", () => {
  const buffer = bufferOf(["alpha"]);
  const index = new SearchIndex();
  index.sync("alpha", buffer);
  buffer.clear();
  push(buffer, "alpha again");
  index.sync("alpha", buffer);
  expect(seqs(index)).toEqual([1]);
  expect(index.currentMatch?.seq).toBe(1);
});

test("an empty query finds nothing", () => {
  const index = new SearchIndex();
  index.sync("", bufferOf(["alpha"]));
  expect(index.matches).toEqual([]);
  expect(index.current).toBe(-1);
  expect(index.step(1)).toBeNull();
});

test("while the buffer drops its oldest lines, the current match stays on its line, then moves to the first one left", () => {
  const buffer = bufferOf(["alpha 1", "beta", "alpha 2", "gamma"], 4);
  const index = new SearchIndex();
  const hits = () =>
    hitsText("alpha", buffer.lines, index.matches.length, index.current);
  index.sync("alpha", buffer);
  expect(seqs(index)).toEqual([0, 2]);
  index.step(1);
  expect(index.currentMatch?.seq).toBe(2);
  expect(hits()).toBe("2 of 2");

  push(buffer, "alpha 3");
  index.sync("alpha", buffer);
  expect(seqs(index)).toEqual([2, 4]);
  expect(index.currentMatch?.seq).toBe(2);
  expect(hits()).toBe("1 of 2");

  for (const text of ["x", "y", "z"]) push(buffer, text);
  index.sync("alpha", buffer);
  expect(seqs(index)).toEqual([4]);
  expect(index.currentMatch?.seq).toBe(4);
  expect(hits()).toBe("1 of 1");
});

test.each<[string, number, number, number, string]>([
  ["", 1, 0, -1, "1 line"],
  ["", 0, 0, -1, "0 lines"],
  ["", 1234, 0, -1, "1,234 lines"],
  ["zzz", 10, 0, -1, "No matches"],
  ["a", 10, 12345, 999, "1,000 of 12,345"],
])(
  "query %j over %i lines with %i matches, current %i, reads %s",
  (query, lines, matches, current, text) => {
    expect(hitsText(query, lines, matches, current)).toBe(text);
  },
);
