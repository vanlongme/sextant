/**
 * Turns one log line with ANSI codes into styled segments. SGR text styles and the
 * 16 basic colors are kept; 256-color and truecolor codes are read and ignored; every
 * other escape sequence is removed. The view renders `segments` as text in `<span>`
 * elements, never through `innerHTML`.
 */

export interface Segment {
  text: string;
  /** A `var(--…)` token, or null for the row's own color. */
  color: string | null;
  background: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  /** Set by search: a match, or the current match. */
  mark: "match" | "current" | null;
}

export interface ParsedLine {
  segments: Segment[];
  /** The text with every escape sequence removed. Search and level detection read it. */
  plain: string;
  /** Whether the line held at least one SGR code. */
  hasSgr: boolean;
}

/** Text colors for ANSI colors 0–7. The bright variants 90–97 use the same tokens. */
export const ANSI_TEXT: readonly string[] = [
  "var(--text-primary)",
  "var(--text-danger)",
  "var(--status-nominal)",
  "var(--status-warning)",
  "var(--border-accent)",
  "var(--border-accent)",
  "var(--border-accent)",
  "var(--text-secondary)",
];

/** Backgrounds for ANSI colors 0–7, also used for 100–107. */
export const ANSI_BACKGROUND: readonly string[] = [
  "var(--status-neutral-soft)",
  "var(--status-critical-soft)",
  "var(--status-nominal-soft)",
  "var(--status-warning-soft)",
  "var(--surface-accent-soft)",
  "var(--surface-accent-soft)",
  "var(--surface-accent-soft)",
  "var(--status-neutral-soft)",
];

const ESC = "\u001b";
const BEL = "\u0007";

type Style = Omit<Segment, "text" | "mark">;

const PLAIN: Style = {
  color: null,
  background: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
};

/** 38, 48 and 58 carry a 256-color or truecolor value, which is ignored. */
const EXTENDED = new Set([38, 48, 58]);

function inRange(code: number, low: number, high: number): boolean {
  return code >= low && code <= high;
}

/**
 * Where the escape sequence that starts at `at` ends, and its parameters when it is
 * an SGR sequence. Always ends after `at`.
 */
function readSequence(
  text: string,
  at: number,
): { end: number; sgr: string | null } {
  const kind = text[at + 1];
  if (kind === "[") {
    // CSI: parameter bytes, intermediate bytes, one final byte.
    let i = at + 2;
    while (i < text.length && inRange(text.charCodeAt(i), 0x30, 0x3f)) i += 1;
    const params = text.slice(at + 2, i);
    const paramsEnd = i;
    while (i < text.length && inRange(text.charCodeAt(i), 0x20, 0x2f)) i += 1;
    if (i < text.length && inRange(text.charCodeAt(i), 0x40, 0x7e)) {
      const isSgr =
        text[i] === "m" && i === paramsEnd && /^[\d;:]*$/.test(params);
      return { end: i + 1, sgr: isSgr ? params : null };
    }
    return { end: i, sgr: null };
  }
  if (kind === "]") {
    // OSC: up to BEL or ESC \, or to the end of the line when left open.
    for (let i = at + 2; i < text.length; i += 1) {
      if (text[i] === BEL) return { end: i + 1, sgr: null };
      if (text[i] === ESC) {
        return { end: text[i + 1] === "\\" ? i + 2 : i, sgr: null };
      }
    }
    return { end: text.length, sgr: null };
  }
  // Any other escape: intermediate bytes, then one final byte, as in ESC ( B.
  let i = at + 1;
  while (i < text.length && inRange(text.charCodeAt(i), 0x20, 0x2f)) i += 1;
  if (i < text.length && inRange(text.charCodeAt(i), 0x30, 0x7e)) {
    return { end: i + 1, sgr: null };
  }
  return { end: i, sgr: null };
}

function applyCode(style: Style, code: number): void {
  if (code === 0) Object.assign(style, PLAIN);
  else if (code === 1) style.bold = true;
  else if (code === 2) style.dim = true;
  else if (code === 3) style.italic = true;
  else if (code === 4) style.underline = true;
  else if (code === 22) {
    style.bold = false;
    style.dim = false;
  } else if (code === 23) style.italic = false;
  else if (code === 24) style.underline = false;
  else if (inRange(code, 30, 37)) style.color = ANSI_TEXT[code - 30] ?? null;
  else if (inRange(code, 90, 97)) style.color = ANSI_TEXT[code - 90] ?? null;
  else if (code === 39) style.color = null;
  else if (inRange(code, 40, 47)) {
    style.background = ANSI_BACKGROUND[code - 40] ?? null;
  } else if (inRange(code, 100, 107)) {
    style.background = ANSI_BACKGROUND[code - 100] ?? null;
  } else if (code === 49) style.background = null;
}

function applySgr(style: Style, params: string): Style {
  const next = { ...style };
  const groups = params === "" ? ["0"] : params.split(";");
  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i] ?? "";
    if (group.includes(":")) {
      // 38:5:n and 38:2::r:g:b carry their whole color in one group.
      const head = Number(group.slice(0, group.indexOf(":")) || "0");
      if (!EXTENDED.has(head)) applyCode(next, head);
      continue;
    }
    const code = group === "" ? 0 : Number(group);
    if (EXTENDED.has(code)) {
      // 38;5;n and 38;2;r;g;b: skip the color's own parameters.
      const mode = groups[i + 1];
      if (mode === "5") i += 2;
      else if (mode === "2") i += 4;
      continue;
    }
    applyCode(next, code);
  }
  return next;
}

function sameStyle(a: Style, b: Style): boolean {
  return (
    a.color === b.color &&
    a.background === b.background &&
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline
  );
}

export function parseAnsi(text: string): ParsedLine {
  if (!text.includes(ESC)) {
    return {
      segments: text === "" ? [] : [{ text, ...PLAIN, mark: null }],
      plain: text,
      hasSgr: false,
    };
  }
  const segments: Segment[] = [];
  let style: Style = { ...PLAIN };
  let plain = "";
  let hasSgr = false;
  const add = (part: string) => {
    if (part === "") return;
    plain += part;
    const last = segments[segments.length - 1];
    if (last && sameStyle(last, style)) last.text += part;
    else segments.push({ text: part, ...style, mark: null });
  };
  let at = 0;
  while (at < text.length) {
    const next = text.indexOf(ESC, at);
    if (next < 0) {
      add(text.slice(at));
      break;
    }
    add(text.slice(at, next));
    const { end, sgr } = readSequence(text, next);
    if (sgr !== null) {
      hasSgr = true;
      style = applySgr(style, sgr);
    }
    at = end;
  }
  return { segments, plain, hasSgr };
}

/**
 * The segments with `patch` applied to the characters from `start` up to `end` of the
 * plain text, splitting segments at the edges. An empty range returns `segments`.
 */
export function overlay(
  segments: Segment[],
  start: number,
  end: number,
  patch: Partial<Segment>,
): Segment[] {
  if (start >= end) return segments;
  const out: Segment[] = [];
  let at = 0;
  for (const segment of segments) {
    const from = at;
    const to = at + segment.text.length;
    at = to;
    if (to <= start || from >= end) {
      out.push(segment);
      continue;
    }
    const a = Math.max(start, from) - from;
    const b = Math.min(end, to) - from;
    if (a > 0) out.push({ ...segment, text: segment.text.slice(0, a) });
    out.push({ ...segment, ...patch, text: segment.text.slice(a, b) });
    if (b < segment.text.length) {
      out.push({ ...segment, text: segment.text.slice(b) });
    }
  }
  return out;
}
