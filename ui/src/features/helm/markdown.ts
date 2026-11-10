/**
 * A small markdown reader for chart READMEs (spec D1 §13). It turns text into a tree
 * that `Markdown` renders as React elements. Nothing here understands HTML: a tag or an
 * entity stays text, so React shows it as typed.
 */

export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "link"; children: Inline[]; url: string }
  | { type: "break" };

export type Block =
  | { type: "heading"; level: number; children: Inline[] }
  | { type: "paragraph"; children: Inline[] }
  | { type: "rule" }
  | { type: "code"; lang: string; text: string }
  | { type: "quote"; children: Block[] }
  | { type: "list"; ordered: boolean; start: number; items: Block[][] }
  | { type: "table"; head: Inline[][]; rows: Inline[][][] };

const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/;
const DELIMITER =
  /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const ESCAPABLE = /[!-/:-@[-`{-~]/;

const blank = (line: string) => line.trim() === "";
const indentOf = (line: string) => line.length - line.trimStart().length;

function dedent(line: string, n: number): string {
  let i = 0;
  while (i < n && line[i] === " ") i += 1;
  return line.slice(i);
}

/** The cells of a table row: split on unescaped pipes, without the outer ones. */
function cells(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  const out: string[] = [];
  let cell = "";
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\\" && text[i + 1] === "|") {
      cell += "|";
      i += 1;
    } else if (text[i] === "|") {
      out.push(cell.trim());
      cell = "";
    } else {
      cell += text[i];
    }
  }
  out.push(cell.trim());
  return out;
}

function tableStarts(lines: string[], i: number): boolean {
  const head = lines[i];
  const delimiter = lines[i + 1];
  if (head === undefined || delimiter === undefined) return false;
  if (!head.includes("|") || !DELIMITER.test(delimiter)) return false;
  return cells(head).length === cells(delimiter).length;
}

function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i] ?? "";
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    ITEM.test(line) ||
    tableStarts(lines, i)
  );
}

/** Reads one list whose items sit at the first line's indentation. */
function readList(
  lines: string[],
  start: number,
  depth: number,
): { block: Block; next: number } {
  const first = ITEM.exec(lines[start] ?? "") as RegExpExecArray;
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items: string[][] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i] as string;
    const item = ITEM.exec(line);
    if (
      item &&
      item[1].length === base &&
      /\d/.test(item[2]) === ordered &&
      !RULE.test(line)
    ) {
      const gap = item[3] ?? " ";
      const width = base + item[2].length + (gap.length > 4 ? 1 : gap.length);
      items.push([item[4] ?? ""]);
      i += 1;
      // The item's own lines: anything indented past its marker, blank lines between
      // them, and lazy lines that carry its paragraph on.
      while (i < lines.length) {
        const next = lines[i] as string;
        const body = items[items.length - 1] as string[];
        if (blank(next)) {
          let j = i;
          while (j < lines.length && blank(lines[j] as string)) j += 1;
          const after = lines[j];
          if (after === undefined || indentOf(after) <= base) break;
          for (; i < j; i += 1) body.push("");
          continue;
        }
        if (indentOf(next) > base) {
          body.push(dedent(next, width));
          i += 1;
          continue;
        }
        const previous = body[body.length - 1] ?? "";
        if (!blank(previous) && !startsBlock(lines, i)) {
          body.push(next);
          i += 1;
          continue;
        }
        break;
      }
      continue;
    }
    if (blank(line)) {
      let j = i;
      while (j < lines.length && blank(lines[j] as string)) j += 1;
      const after = ITEM.exec(lines[j] ?? "");
      if (
        after &&
        after[1].length === base &&
        /\d/.test(after[2]) === ordered
      ) {
        i = j;
        continue;
      }
    }
    break;
  }
  return {
    block: {
      type: "list",
      ordered,
      start: ordered ? Number.parseInt(first[2], 10) : 1,
      items: items.map((body) => parseBlocks(body, depth + 1)),
    },
    next: i,
  };
}

/** Quotes and lists nest at most this deep; deeper markers stay as text. */
const MAX_DEPTH = 32;

function parseBlocks(lines: string[], depth = 0): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence && !(fence[2][0] === "`" && fence[3].includes("`"))) {
      const marker = fence[2];
      const close = new RegExp(
        `^ {0,3}${marker[0]}{${marker.length},}[ \\t]*$`,
      );
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !close.test(lines[i] as string)) {
        body.push(dedent(lines[i] as string, fence[1].length));
        i += 1;
      }
      i += 1;
      const lang = fence[3].trim().split(/\s+/)[0] ?? "";
      blocks.push({ type: "code", lang, text: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1].length,
        children: parseInline(heading[2] ?? ""),
      });
      i += 1;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ type: "rule" });
      i += 1;
      continue;
    }
    if (depth < MAX_DEPTH && QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length) {
        const quoted = QUOTE.exec(lines[i] as string);
        if (!quoted) break;
        body.push(quoted[1]);
        i += 1;
      }
      blocks.push({ type: "quote", children: parseBlocks(body, depth + 1) });
      continue;
    }
    if (depth < MAX_DEPTH && ITEM.test(line)) {
      const { block, next } = readList(lines, i, depth);
      blocks.push(block);
      i = next;
      continue;
    }
    if (tableStarts(lines, i)) {
      const head = cells(line);
      const width = head.length;
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length) {
        const row = lines[i] as string;
        if (blank(row) || !row.includes("|")) break;
        const values = cells(row).slice(0, width);
        while (values.length < width) values.push("");
        rows.push(values.map(parseInline));
        i += 1;
      }
      blocks.push({ type: "table", head: head.map(parseInline), rows });
      continue;
    }
    const body = [line];
    i += 1;
    while (
      i < lines.length &&
      !blank(lines[i] as string) &&
      !startsBlock(lines, i)
    ) {
      body.push(lines[i] as string);
      i += 1;
    }
    blocks.push({
      type: "paragraph",
      children: parseInline(
        body
          .map((l) => l.trimStart())
          .join("\n")
          .trimEnd(),
      ),
    });
  }
  return blocks;
}

/** Where `[`'s matching `]` is, counting nested brackets; -1 when there is none. */
function closingBracket(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "\\") {
      i += 1;
    } else if (text[i] === "[") {
      depth += 1;
    } else if (text[i] === "]") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** A link destination right after `]`: `(url)` or `(url "title")`. */
function destination(
  text: string,
  at: number,
): { url: string; end: number } | null {
  if (text[at] !== "(") return null;
  let i = at + 1;
  while (text[i] === " ") i += 1;
  let url = "";
  if (text[i] === "<") {
    const close = text.indexOf(">", i);
    if (close < 0) return null;
    url = text.slice(i + 1, close);
    i = close + 1;
  } else {
    let depth = 0;
    while (i < text.length) {
      const ch = text[i] as string;
      if (ch === " " || ch === "\n") break;
      if (ch === "(") depth += 1;
      if (ch === ")") {
        if (depth === 0) break;
        depth -= 1;
      }
      url += ch;
      i += 1;
    }
  }
  while (text[i] === " " || text[i] === "\n") i += 1;
  const quote = text[i];
  if (quote === '"' || quote === "'") {
    const close = text.indexOf(quote, i + 1);
    if (close < 0) return null;
    i = close + 1;
    while (text[i] === " ") i += 1;
  }
  if (text[i] !== ")") return null;
  return { url, end: i + 1 };
}

/** Where a run of backticks exactly as long as `run` starts, from `from`; -1 when none. */
function closingRun(text: string, from: number, run: string): number {
  let at = text.indexOf(run, from);
  while (at >= 0) {
    let end = at;
    while (text[end] === "`") end += 1;
    if (end - at === run.length) return at;
    at = text.indexOf(run, end);
  }
  return -1;
}

const wordChar = (ch: string | undefined) =>
  ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
const space = (ch: string | undefined) => ch === undefined || /\s/.test(ch);

/** Where an emphasis opened at `at` with `marker` closes; -1 when it does not. */
function closingMarker(text: string, at: number, marker: string): number {
  const ch = marker[0] as string;
  const from = at + marker.length;
  if (space(text[from])) return -1;
  if (ch === "_" && wordChar(text[at - 1])) return -1;
  for (let i = from + 1; i < text.length; i += 1) {
    if (text[i] === "\\") {
      i += 1;
      continue;
    }
    if (text[i] === "`") {
      const run = /^`+/.exec(text.slice(i))?.[0] ?? "`";
      const end = closingRun(text, i + run.length, run);
      i = end < 0 ? i + run.length - 1 : end + run.length - 1;
      continue;
    }
    if (!text.startsWith(marker, i)) continue;
    // A single marker skips over a double one, which is strong text inside it.
    if (marker.length === 1 && text[i + 1] === ch) {
      const inner = text.indexOf(ch + ch, i + 2);
      if (inner < 0) return -1;
      i = inner + 1;
      continue;
    }
    if (space(text[i - 1])) continue;
    if (ch === "_" && wordChar(text[i + marker.length])) continue;
    return i;
  }
  return -1;
}

function push(out: Inline[], node: Inline): void {
  const last = out[out.length - 1];
  if (node.type === "text" && last?.type === "text") {
    last.text += node.text;
  } else {
    out.push(node);
  }
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let i = 0;
  const literal = (s: string) => push(out, { type: "text", text: s });
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === "\\" && ESCAPABLE.test(text[i + 1] ?? "")) {
      literal(text[i + 1] as string);
      i += 2;
      continue;
    }
    if (ch === "\n") {
      const last = out[out.length - 1];
      if (last?.type === "text" && /(?: {2,}|\\)$/.test(last.text)) {
        last.text = last.text.replace(/(?: {2,}|\\)$/, "");
        out.push({ type: "break" });
      } else {
        literal("\n");
      }
      i += 1;
      continue;
    }
    if (ch === "`") {
      const run = /^`+/.exec(text.slice(i))?.[0] as string;
      const end = closingRun(text, i + run.length, run);
      if (end > 0) {
        let code = text.slice(i + run.length, end).replace(/\n/g, " ");
        if (/^ .*[^ ].* $/.test(code)) code = code.slice(1, -1);
        out.push({ type: "code", text: code });
        i = end + run.length;
      } else {
        literal(run);
        i += run.length;
      }
      continue;
    }
    if (ch === "!" && text[i + 1] === "[") {
      const close = closingBracket(text, i + 1);
      const dest = close < 0 ? null : destination(text, close + 1);
      if (dest) {
        literal(text.slice(i + 2, close));
        i = dest.end;
        continue;
      }
    }
    if (ch === "[") {
      const close = closingBracket(text, i);
      const dest = close < 0 ? null : destination(text, close + 1);
      if (dest) {
        out.push({
          type: "link",
          children: parseInline(text.slice(i + 1, close)),
          url: dest.url,
        });
        i = dest.end;
        continue;
      }
    }
    if (ch === "<") {
      const auto = /^<(https?:\/\/[^\s<>]+)>/.exec(text.slice(i));
      if (auto) {
        literal(auto[1] as string);
        i += auto[0].length;
        continue;
      }
    }
    if (ch === "*" || ch === "_") {
      const double = text[i + 1] === ch ? ch + ch : null;
      if (double) {
        const end = closingMarker(text, i, double);
        if (end > 0) {
          out.push({
            type: "strong",
            children: parseInline(text.slice(i + 2, end)),
          });
          i = end + 2;
          continue;
        }
      }
      const end = closingMarker(text, i, ch);
      if (end > 0) {
        out.push({ type: "em", children: parseInline(text.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
      literal(double ?? ch);
      i += double ? 2 : 1;
      continue;
    }
    literal(ch);
    i += 1;
  }
  return out;
}

export function parseMarkdown(text: string): Block[] {
  try {
    return parseBlocks(
      text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n"),
    );
  } catch {
    // READMEs are untrusted: never let a parser failure unmount the app.
    return [{ type: "paragraph", children: [{ type: "text", text }] }];
  }
}
