/**
 * Fuzzy matching for the command palette (spec C §6.3). The query is compared
 * character by character and never turned into a RegExp, so every character is
 * literal.
 */

export interface Match {
  score: number;
  /** Half-open [start, end) runs of matched characters, drawn in bold accent. */
  ranges: [number, number][];
}

export function isBlank(query: string): boolean {
  return query.trim() === "";
}

const SEPARATORS = new Set([" ", "-", ".", "/"]);

function isLower(c: string): boolean {
  return c !== c.toUpperCase();
}

function isUpper(c: string): boolean {
  return c !== c.toLowerCase();
}

/** After a space, `-`, `.` or `/`, or a lower-to-upper case change. */
function isWordStart(label: string, i: number): boolean {
  if (i === 0) return true;
  const before = label[i - 1];
  return SEPARATORS.has(before) || (isLower(before) && isUpper(label[i]));
}

function toRanges(positions: number[]): [number, number][] {
  const ranges: [number, number][] = [];
  for (const p of positions) {
    const last = ranges[ranges.length - 1];
    if (last !== undefined && last[1] === p) last[1] = p + 1;
    else ranges.push([p, p + 1]);
  }
  return ranges;
}

/**
 * Whether the query's characters (spaces ignored) appear in the label in order,
 * ignoring case. The match is the shortest window that ends where the query first
 * matches in full. Each matched character scores 1, plus 5 when it follows the
 * previous match and 8 at a word start; an early first match adds up to 5 and a
 * short label up to 2.
 */
export function fuzzyMatch(query: string, label: string): Match | null {
  const needle = query
    .split("")
    .filter((c) => c.trim() !== "")
    .map((c) => c.toLowerCase());
  if (needle.length === 0) return null;
  const hay = label.split("").map((c) => c.toLowerCase());

  // Forward: where the whole query has matched for the first time.
  let next = 0;
  let end = -1;
  for (let i = 0; i < hay.length && end < 0; i++) {
    if (hay[i] === needle[next]) {
      next += 1;
      if (next === needle.length) end = i;
    }
  }
  if (end < 0) return null;

  // Backward from there: the latest start, so the window is as short as it can be.
  let start = end;
  let back = needle.length - 1;
  for (let i = end; i >= 0 && back >= 0; i--) {
    if (hay[i] === needle[back]) {
      back -= 1;
      start = i;
    }
  }

  // Forward inside the window: the positions to score and draw.
  const positions: number[] = [];
  next = 0;
  for (let i = start; i <= end && next < needle.length; i++) {
    if (hay[i] === needle[next]) {
      positions.push(i);
      next += 1;
    }
  }

  let score = 0;
  let previous = -2;
  for (const p of positions) {
    score += 1;
    if (p === previous + 1) score += 5;
    if (isWordStart(label, p)) score += 8;
    previous = p;
  }
  score += Math.max(0, 5 - 0.5 * positions[0]);
  score += Math.max(0, 2 - 0.02 * label.length);
  return { score, ranges: toRanges(positions) };
}

/** The label, or else the hint at half the score and without highlight. */
export function matchEntry(
  query: string,
  label: string,
  hint: string | null,
): Match | null {
  const own = fuzzyMatch(query, label);
  if (own !== null || hint === null) return own;
  const other = fuzzyMatch(query, hint);
  return other === null ? null : { score: other.score / 2, ranges: [] };
}
