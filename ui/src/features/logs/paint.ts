import { overlay, type ParsedLine, parseAnsi, type Segment } from "./ansi";
import { detectLevel, LEVEL_COLORS } from "./level";
import type { LogLineEntry, LogMarkerEntry } from "./logBuffer";

const parsed = new WeakMap<LogLineEntry, ParsedLine>();

/** A line's segments and plain text, parsed once per entry. */
export function parsedLine(entry: LogLineEntry): ParsedLine {
  let line = parsed.get(entry);
  if (!line) {
    line = parseAnsi(entry.text);
    parsed.set(entry, line);
  }
  return line;
}

/** A search match on a line, as offsets in its plain text. */
export interface Mark {
  start: number;
  end: number;
  current: boolean;
}

/**
 * The segments to draw for a line: its ANSI styles; the level word's color when the
 * line has no SGR code (spec §6.7); then the search marks.
 */
export function paintLine(
  entry: LogLineEntry,
  marks: readonly Mark[] = [],
): Segment[] {
  const line = parsedLine(entry);
  let segments = line.segments;
  if (!line.hasSgr) {
    const level = detectLevel(line.plain);
    if (level) {
      segments = overlay(segments, level.start, level.end, {
        color: LEVEL_COLORS[level.level],
      });
    }
  }
  for (const m of marks) {
    segments = overlay(segments, m.start, m.end, {
      mark: m.current ? "current" : "match",
    });
  }
  return segments;
}

/** The text of a marker row (spec §6.4). */
export function markerText(entry: LogMarkerEntry): string {
  const { pod, container, message } = entry;
  const detail = message ? `: ${message}` : "";
  switch (entry.marker) {
    case "restarted":
      return container ? `${pod}/${container} restarted` : `${pod} restarted`;
    case "reconnecting":
      return `Reconnecting to ${pod}…${detail}`;
    case "reconnected":
      return `Reconnected to ${pod}`;
    case "podAdded":
      return `Pod ${pod} added`;
    case "podRemoved":
      return `Pod ${pod} removed`;
    case "failed":
      return `Could not read ${pod}${detail}`;
  }
}

export type PrefixMode = "none" | "container" | "pod" | "pod-container";

/**
 * What each line starts with (spec §6.5): all Pods of a workload show the Pod, and the
 * container too when more than one is read; one Pod read across its containers
 * shows the container.
 */
export function prefixMode(args: {
  podTab: boolean;
  pod: string;
  container: string | null;
  containerCount: number;
}): PrefixMode {
  if (!args.podTab && args.pod === "all") {
    return args.container === null && args.containerCount > 1
      ? "pod-container"
      : "pod";
  }
  return args.container === null ? "container" : "none";
}

/** The part of a Pod name after its last "-". */
export function podSuffix(pod: string): string {
  return pod.slice(pod.lastIndexOf("-") + 1);
}

export function prefixText(
  mode: PrefixMode,
  pod: string,
  container: string,
): string | null {
  switch (mode) {
    case "none":
      return null;
    case "container":
      return container;
    case "pod":
      return podSuffix(pod);
    case "pod-container":
      return `${podSuffix(pod)} ${container}`;
  }
}

export const PREFIX_COLORS: readonly string[] = [
  "var(--border-accent)",
  "var(--status-nominal)",
  "var(--text-secondary)",
];

/** The prefix color of the Pod that appeared `order`-th. */
export function prefixColor(order: number): string {
  return PREFIX_COLORS[order % PREFIX_COLORS.length];
}
