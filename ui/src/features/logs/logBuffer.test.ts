import { expect, test } from "vitest";
import { LOG_CAPACITY, LogBuffer, type NewLogEntry } from "./logBuffer";

function line(text: string, pod = "web-1"): NewLogEntry {
  return {
    kind: "line",
    pod,
    container: "main",
    timestamp: null,
    text,
    truncated: false,
  };
}

function marker(pod = "web-1"): NewLogEntry {
  return {
    kind: "marker",
    pod,
    container: null,
    marker: "restarted",
    message: null,
  };
}

const texts = (b: LogBuffer) =>
  b.toArray().map((e) => (e.kind === "line" ? e.text : `[${e.marker}]`));

test("holds 100,000 entries by default", () => {
  expect(LOG_CAPACITY).toBe(100_000);
  expect(new LogBuffer().capacity).toBe(100_000);
});

test("keeps entries in order and gives each a growing seq", () => {
  const b = new LogBuffer(5);
  b.push(line("a"));
  b.push(line("b"));
  b.push(marker());
  expect(texts(b)).toEqual(["a", "b", "[restarted]"]);
  expect(b.toArray().map((e) => e.seq)).toEqual([0, 1, 2]);
  expect(b.size).toBe(3);
  expect(b.lines).toBe(2);
});

test("drops the oldest entries at capacity, and seq keeps growing", () => {
  const b = new LogBuffer(3);
  for (const t of ["a", "b", "c", "d", "e"]) b.push(line(t));
  expect(texts(b)).toEqual(["c", "d", "e"]);
  expect(b.toArray().map((e) => e.seq)).toEqual([2, 3, 4]);
  expect(b.firstSeq).toBe(2);
  expect(b.at(0)?.seq).toBe(2);
  expect(b.at(3)).toBeUndefined();
  expect(b.at(-1)).toBeUndefined();
  expect(b.indexOf(4)).toBe(2);
  expect(b.indexOf(1)).toBe(-1);
  expect(b.indexOf(5)).toBe(-1);
});

test("counts lines, and stops counting the ones it drops", () => {
  const b = new LogBuffer(2);
  b.push(marker());
  b.push(line("a"));
  expect(b.lines).toBe(1);
  b.push(line("b"));
  expect([b.size, b.lines]).toEqual([2, 2]);
  b.push(marker());
  expect([b.size, b.lines]).toEqual([2, 1]);
});

test("numbers Pods in the order they first appear", () => {
  const b = new LogBuffer(10);
  b.push(line("a", "web-2"));
  b.push(line("b", "web-1"));
  b.push(line("c", "web-2"));
  expect([b.podOrder("web-2"), b.podOrder("web-1")]).toEqual([0, 1]);
});

test("clear empties the buffer, starts a new epoch and never reuses a seq", () => {
  const b = new LogBuffer(3);
  b.push(line("a", "web-1"));
  b.push(line("b", "web-2"));
  const epoch = b.epoch;
  b.clear();
  expect([b.size, b.lines, b.epoch]).toEqual([0, 0, epoch + 1]);
  expect(b.firstSeq).toBe(2);
  expect(b.push(line("c", "web-2")).seq).toBe(2);
  expect(b.podOrder("web-2")).toBe(0);
  expect(texts(b)).toEqual(["c"]);
});
