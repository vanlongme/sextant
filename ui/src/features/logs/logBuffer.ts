import type { LogMarker } from "../../ipc/generated/LogMarker";

/** The most entries a Logs tab keeps. The oldest go first. */
export const LOG_CAPACITY = 100_000;

export interface LogLineEntry {
  kind: "line";
  /** Grows by one per entry and never repeats in one buffer, also across `clear`. */
  seq: number;
  pod: string;
  container: string;
  timestamp: string | null;
  /** As sent, ANSI codes included. */
  text: string;
  /** The backend cut the line at 64 KiB. */
  truncated: boolean;
}

export interface LogMarkerEntry {
  kind: "marker";
  seq: number;
  pod: string;
  container: string | null;
  marker: LogMarker;
  message: string | null;
}

export type LogEntry = LogLineEntry | LogMarkerEntry;

/** An entry before the buffer gives it its `seq`. */
export type NewLogEntry =
  | Omit<LogLineEntry, "seq">
  | Omit<LogMarkerEntry, "seq">;

/**
 * A ring buffer of log entries, with no React in it. Index 0 is the oldest entry
 * kept; at capacity each new entry drops the oldest.
 */
export class LogBuffer {
  readonly capacity: number;
  private slots: (LogEntry | undefined)[];
  private head = 0;
  private count = 0;
  private nextSeq = 0;
  private lineCount = 0;
  private generation = 0;
  private pods = new Map<string, number>();

  constructor(capacity = LOG_CAPACITY) {
    this.capacity = capacity;
    this.slots = new Array<LogEntry | undefined>(capacity);
  }

  /** How many entries are kept, lines and markers. */
  get size(): number {
    return this.count;
  }

  /** How many of the kept entries are lines. */
  get lines(): number {
    return this.lineCount;
  }

  /** The `seq` of the oldest entry kept, or of the next one when the buffer is empty. */
  get firstSeq(): number {
    return this.nextSeq - this.count;
  }

  /** Grows by one on each `clear`. */
  get epoch(): number {
    return this.generation;
  }

  push(entry: NewLogEntry): LogEntry {
    const stored = { ...entry, seq: this.nextSeq } as LogEntry;
    this.nextSeq += 1;
    if (this.count === this.capacity) {
      const dropped = this.slots[this.head];
      if (dropped?.kind === "line") this.lineCount -= 1;
      this.slots[this.head] = stored;
      this.head = (this.head + 1) % this.capacity;
    } else {
      this.slots[(this.head + this.count) % this.capacity] = stored;
      this.count += 1;
    }
    if (stored.kind === "line") this.lineCount += 1;
    if (!this.pods.has(stored.pod)) this.pods.set(stored.pod, this.pods.size);
    return stored;
  }

  at(index: number): LogEntry | undefined {
    if (index < 0 || index >= this.count) return undefined;
    return this.slots[(this.head + index) % this.capacity];
  }

  /** The index of the entry with `seq`, or -1 when it is not kept. */
  indexOf(seq: number): number {
    const index = seq - this.firstSeq;
    return index >= 0 && index < this.count ? index : -1;
  }

  /** The order in which `pod` first appeared since the last `clear`, from 0. */
  podOrder(pod: string): number {
    return this.pods.get(pod) ?? 0;
  }

  toArray(): LogEntry[] {
    const out: LogEntry[] = [];
    for (let i = 0; i < this.count; i += 1) {
      const entry = this.at(i);
      if (entry) out.push(entry);
    }
    return out;
  }

  clear(): void {
    this.slots = new Array<LogEntry | undefined>(this.capacity);
    this.head = 0;
    this.count = 0;
    this.lineCount = 0;
    this.pods.clear();
    this.generation += 1;
  }
}
