import { expect, test } from "vitest";
import type { LogLineEntry, LogMarkerEntry } from "./logBuffer";
import {
  markerText,
  type PrefixMode,
  paintLine,
  parsedLine,
  podSuffix,
  prefixColor,
  prefixMode,
  prefixText,
} from "./paint";

function lineEntry(text: string): LogLineEntry {
  return {
    kind: "line",
    seq: 0,
    pod: "web-1",
    container: "app",
    timestamp: null,
    text,
    truncated: false,
  };
}

test("a line is parsed once", () => {
  const entry = lineEntry("\u001b[1mbold\u001b[0m");
  expect(parsedLine(entry)).toBe(parsedLine(entry));
  expect(parsedLine(entry).plain).toBe("bold");
});

test("a line with no SGR code gets its level word colored", () => {
  expect(
    paintLine(lineEntry("ERROR disk full")).map((s) => [s.text, s.color]),
  ).toEqual([
    ["ERROR", "var(--text-danger)"],
    [" disk full", null],
  ]);
});

test("a line with SGR codes keeps its own colors and gets no level color", () => {
  expect(
    paintLine(lineEntry("\u001b[32mERROR\u001b[0m disk full")).map((s) => [
      s.text,
      s.color,
    ]),
  ).toEqual([
    ["ERROR", "var(--status-nominal)"],
    [" disk full", null],
  ]);
});

test("search marks split the segments, the current one apart", () => {
  const segments = paintLine(lineEntry("alpha beta alpha"), [
    { start: 0, end: 5, current: false },
    { start: 11, end: 16, current: true },
  ]);
  expect(segments.map((s) => [s.text, s.mark])).toEqual([
    ["alpha", "match"],
    [" beta ", null],
    ["alpha", "current"],
  ]);
});

test.each<[LogMarkerEntry["marker"], string | null, string | null, string]>([
  ["restarted", "app", null, "web-1/app restarted"],
  ["restarted", null, null, "web-1 restarted"],
  ["reconnecting", null, null, "Reconnecting to web-1…"],
  [
    "reconnecting",
    null,
    "connection reset",
    "Reconnecting to web-1…: connection reset",
  ],
  ["reconnected", null, null, "Reconnected to web-1"],
  ["podAdded", null, null, "Pod web-1 added"],
  ["podRemoved", null, null, "Pod web-1 removed"],
  ["failed", null, null, "Could not read web-1"],
  [
    "failed",
    "app",
    "container not found",
    "Could not read web-1: container not found",
  ],
])(
  "marker %s (container %s, message %s) reads %s",
  (marker, container, message, text) => {
    expect(
      markerText({
        kind: "marker",
        seq: 0,
        pod: "web-1",
        container,
        marker,
        message,
      }),
    ).toBe(text);
  },
);

test.each<[boolean, string, string | null, number, PrefixMode]>([
  [false, "all", null, 2, "pod-container"],
  [false, "all", null, 1, "pod"],
  [false, "all", "main", 2, "pod"],
  [false, "web-1", null, 2, "container"],
  [false, "web-1", "main", 2, "none"],
  [true, "all", null, 2, "container"],
  [true, "all", "app", 2, "none"],
])(
  "Pod tab %s, pod %s, container %s, %i containers: prefix %s",
  (podTab, pod, container, containerCount, mode) => {
    expect(prefixMode({ podTab, pod, container, containerCount })).toBe(mode);
  },
);

test("prefixes read the last part of the Pod name, then the container", () => {
  expect(prefixText("pod-container", "web-7d9f-aaaaa", "proxy")).toBe(
    "aaaaa proxy",
  );
  expect(prefixText("pod", "web-7d9f-aaaaa", "proxy")).toBe("aaaaa");
  expect(prefixText("container", "web-7d9f-aaaaa", "proxy")).toBe("proxy");
  expect(prefixText("none", "web-7d9f-aaaaa", "proxy")).toBeNull();
  expect(podSuffix("single")).toBe("single");
});

test("prefix colors cycle in the order Pods appear", () => {
  expect([0, 1, 2, 3].map(prefixColor)).toEqual([
    "var(--border-accent)",
    "var(--status-nominal)",
    "var(--text-secondary)",
    "var(--border-accent)",
  ]);
});
