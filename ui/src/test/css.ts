/** Raw text of every stylesheet under ui/src, keyed by path from the project root. */
export const CSS_FILES: Record<string, string> = import.meta.glob<string>(
  "/src/**/*.css",
  { query: "?raw", import: "default", eager: true },
);

export interface CssRule {
  selector: string;
  decls: [string, string][];
}

/**
 * The style rules of a stylesheet, flattened out of `@media` blocks. Rules inside
 * `@keyframes` are left out. Comments are ignored.
 */
export function cssRules(css: string): CssRule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: CssRule[] = [];
  const stack: string[] = [];
  let buf = "";
  for (const ch of text) {
    if (ch === "{") {
      stack.push(buf.trim());
      buf = "";
    } else if (ch === "}") {
      const selector = stack.pop() ?? "";
      const body = buf.trim();
      const inKeyframes = stack.some((s) => s.startsWith("@keyframes"));
      if (body && !selector.startsWith("@") && !inKeyframes) {
        const decls = body
          .split(";")
          .map((d) => d.trim())
          .filter(Boolean)
          .map((d): [string, string] => {
            const i = d.indexOf(":");
            return [d.slice(0, i).trim(), d.slice(i + 1).trim()];
          });
        out.push({ selector, decls });
      }
      buf = "";
    } else {
      buf += ch;
    }
  }
  return out;
}

/** Every `var(--name)` reference in a stylesheet, fallbacks included. */
export function varNames(css: string): string[] {
  return [...css.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)].map((m) => m[1]);
}

/** Every custom property a stylesheet declares. */
export function declaredNames(css: string): string[] {
  return [...css.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]);
}
