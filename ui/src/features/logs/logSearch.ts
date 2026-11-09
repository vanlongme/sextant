import type { LogBuffer, LogEntry } from "./logBuffer";
import { parsedLine } from "./paint";

/** The query runs this long after the last keystroke. */
export const SEARCH_DELAY_MS = 150;

/** One occurrence of the query, as offsets in a line's plain text. */
export interface LogMatch {
  seq: number;
  start: number;
  end: number;
}

/** The query as a literal, case-insensitive pattern; null for an empty query. */
export function searchPattern(query: string): RegExp | null {
  if (query === "") return null;
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
}

/** The matches in one entry's text with its ANSI codes removed. Markers have none. */
export function findInEntry(entry: LogEntry, pattern: RegExp): LogMatch[] {
  if (entry.kind !== "line") return [];
  const out: LogMatch[] = [];
  for (const m of parsedLine(entry).plain.matchAll(pattern)) {
    const start = m.index ?? 0;
    out.push({ seq: entry.seq, start, end: start + m[0].length });
  }
  return out;
}

/**
 * The matches of one query over a buffer that grows at the end and drops at the
 * start. `sync` reads only the entries it has not seen. The current match is kept
 * by identity, so it stays on its line as others come and go.
 */
export class SearchIndex {
  private query = "";
  private pattern: RegExp | null = null;
  private list: LogMatch[] = [];
  private currentRef: LogMatch | null = null;
  private epoch = -1;
  private nextSeq = 0;

  get matches(): readonly LogMatch[] {
    return this.list;
  }

  get currentMatch(): LogMatch | null {
    return this.currentRef;
  }

  /** The current match's index in `matches`, or -1. */
  get current(): number {
    return this.currentRef ? this.list.indexOf(this.currentRef) : -1;
  }

  /** Brings the index up to date. Returns whether the query changed. */
  sync(query: string, buffer: LogBuffer): boolean {
    const changed = query !== this.query;
    if (changed || buffer.epoch !== this.epoch) {
      this.query = query;
      this.pattern = searchPattern(query);
      this.list = [];
      this.currentRef = null;
      this.epoch = buffer.epoch;
      this.nextSeq = buffer.firstSeq;
    }
    const first = buffer.firstSeq;
    // Drop the matches on lines the buffer no longer keeps.
    if (this.list.length > 0 && this.list[0].seq < first) {
      const keep = this.list.findIndex((m) => m.seq >= first);
      this.list = keep === -1 ? [] : this.list.slice(keep);
      if (this.currentRef && this.currentRef.seq < first)
        this.currentRef = null;
    }
    const end = first + buffer.size;
    if (this.pattern) {
      for (let seq = Math.max(this.nextSeq, first); seq < end; seq += 1) {
        const entry = buffer.at(seq - first);
        if (entry) this.list.push(...findInEntry(entry, this.pattern));
      }
    }
    this.nextSeq = end;
    if (this.currentRef === null && this.list.length > 0) {
      this.currentRef = this.list[0];
    }
    return changed;
  }

  /** Makes the next or previous match current, wrapping around. */
  step(direction: 1 | -1): LogMatch | null {
    const n = this.list.length;
    if (n === 0) return null;
    const at = this.current;
    const next = at === -1 ? 0 : (at + direction + n) % n;
    this.currentRef = this.list[next];
    return this.currentRef;
  }

  /** The matches on the entry with `seq`. */
  on(seq: number): LogMatch[] {
    let lo = 0;
    let hi = this.list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.list[mid].seq < seq) lo = mid + 1;
      else hi = mid;
    }
    const out: LogMatch[] = [];
    for (let i = lo; i < this.list.length && this.list[i].seq === seq; i += 1) {
      out.push(this.list[i]);
    }
    return out;
  }
}

/** The count next to the search field (spec §6.1). */
export function hitsText(
  query: string,
  lines: number,
  matches: number,
  current: number,
): string {
  if (query === "") {
    return lines === 1 ? "1 line" : `${lines.toLocaleString("en-US")} lines`;
  }
  if (matches === 0) return "No matches";
  return `${(current + 1).toLocaleString("en-US")} of ${matches.toLocaleString("en-US")}`;
}
