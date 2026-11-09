import type { LogLevel } from "../../ipc/generated/LogLevel";

export interface LevelMatch {
  level: LogLevel;
  /** The colored characters, as offsets in the line's plain text. */
  start: number;
  end: number;
}

export const LEVEL_COLORS: Record<LogLevel, string> = {
  info: "var(--text-secondary)",
  warn: "var(--status-warning)",
  error: "var(--text-danger)",
};

/** Only the start of a line is read. */
const SCAN = 64;

const WORDS = new Map<string, LogLevel>([
  ["info", "info"],
  ["warn", "warn"],
  ["warning", "warn"],
  ["error", "error"],
  ["err", "error"],
  ["fatal", "error"],
]);

const KLOG = /^([IWEF])\d{4} /;
const JSON_FORM = /"level"\s*:\s*"([A-Za-z]+)"/;
const LOGFMT_FORM = /\b(?:level|lvl)="?([A-Za-z]+)/;
const BRACKETED = /^\[([A-Za-z]+)\](?=$|[\s:])/;
const LEADING = /^([A-Za-z]+)(?=$|[\s:])/;

function fromWord(word: string, start: number): LevelMatch | null {
  const level = WORDS.get(word.toLowerCase());
  return level ? { level, start, end: start + word.length } : null;
}

/** The word a form captured, where it stands in the line. */
function captured(match: RegExpExecArray): LevelMatch | null {
  const word = match[1] ?? "";
  return fromWord(word, match.index + match[0].lastIndexOf(word));
}

/**
 * The level a line prints, looking in its first 64 characters for, in order: a klog
 * prefix, `"level":"<word>"`, `level=<word>` or `lvl=<word>`, and a leading word alone
 * or in brackets. The first form found decides; a word other than info, warn,
 * warning, error, err and fatal, in any case, gives no level.
 */
export function detectLevel(plain: string): LevelMatch | null {
  const head = plain.slice(0, SCAN);
  const klog = KLOG.exec(head);
  if (klog) {
    const letter = klog[1];
    const level: LogLevel =
      letter === "I" ? "info" : letter === "W" ? "warn" : "error";
    return { level, start: 0, end: 1 };
  }
  for (const form of [JSON_FORM, LOGFMT_FORM]) {
    const match = form.exec(head);
    if (match) return captured(match);
  }
  const bracketed = BRACKETED.exec(head);
  if (bracketed) return fromWord(bracketed[1] ?? "", 1);
  const leading = LEADING.exec(head);
  return leading ? fromWord(leading[1] ?? "", 0) : null;
}
