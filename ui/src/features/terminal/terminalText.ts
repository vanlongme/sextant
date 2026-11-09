export type NoteTone = "note" | "error";

const RESET = "\u001b[0m";
const DIM = "\u001b[2m";
/** ANSI red, which the terminal theme maps to its red. */
const RED = "\u001b[31m";

/**
 * `text` without C0 controls (U+0000–U+001F), DEL and C1 controls (U+0080–U+009F), so
 * no escape sequence from the backend or the cluster reaches the terminal. A run of line
 * breaks and tabs becomes one space, which keeps the note on its own line and its words
 * apart.
 */
export function stripControls(text: string): string {
  let out = "";
  let breaking = false;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      if (!breaking) out += " ";
      breaking = true;
      continue;
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    breaking = false;
    out += ch;
  }
  return out;
}

/** One note for xterm: plain text, dim or red, then a line break. */
export function noteLine(text: string, tone: NoteTone): string {
  return `${RESET}${tone === "note" ? DIM : RED}${stripControls(text)}${RESET}\r\n`;
}
