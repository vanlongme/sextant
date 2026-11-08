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

/**
 * Whether a rule with this selector sets custom properties on <html> in a theme, or
 * null for a selector that is not about <html>. theme.ts always sets `data-theme` to
 * "light" or "dark", so <html> always carries one of the two.
 */
function appliesToRoot(
  selector: string,
  theme: "light" | "dark",
): boolean | null {
  const s = selector
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
  // `:root` matches <html> whatever its data-theme, so the light block is also the dark
  // theme's base; the dark block comes later in the file with the same specificity.
  if (s === ":root" || s === ':root, [data-theme="light"]') return true;
  if (s === '[data-theme="dark"]') return theme === "dark";
  if (s === ':root:not([data-theme="dark"])') return theme === "light";
  return null;
}

/**
 * The custom properties in effect on <html> for a theme, read in source order from
 * tinyorbit.css then global.css as the cascade does, with every `var()` resolved.
 */
export function themeTokens(theme: "light" | "dark"): Map<string, string> {
  const raw = new Map<string, string>();
  for (const file of ["/src/design/tinyorbit.css", "/src/design/global.css"]) {
    for (const rule of cssRules(CSS_FILES[file])) {
      if (!appliesToRoot(rule.selector, theme)) continue;
      for (const [name, value] of rule.decls) {
        if (name.startsWith("--")) raw.set(name, value);
      }
    }
  }
  const resolve = (value: string, depth = 0): string =>
    depth > 10
      ? value
      : value.replace(/var\((--[a-zA-Z0-9-]+)\)/g, (_, n: string) =>
          resolve(raw.get(n) ?? `var(${n})`, depth + 1),
        );
  return new Map([...raw].map(([n, v]) => [n, resolve(v)]));
}

type Rgba = [number, number, number, number];

function parseColor(c: string): Rgba {
  const hex = c.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = Number.parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgba = c.match(/^rgba?\(([^)]+)\)$/);
  if (rgba) {
    const [r, g, b, a = "1"] = rgba[1].split(",").map((p) => p.trim());
    return [Number(r), Number(g), Number(b), Number(a)];
  }
  throw new Error(`not a colour: ${c}`);
}

function over(top: Rgba, under: Rgba): Rgba {
  const a = top[3];
  return [
    top[0] * a + under[0] * (1 - a),
    top[1] * a + under[1] * (1 - a),
    top[2] * a + under[2] * (1 - a),
    1,
  ];
}

function luminance([r, g, b]: Rgba): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * WCAG contrast of `fg` on `bg`. A translucent `bg` is laid over `under` first, and a
 * translucent `fg` over the result.
 */
export function contrast(fg: string, bg: string, under = "#ffffff"): number {
  const base = over(parseColor(bg), parseColor(under));
  const top = over(parseColor(fg), base);
  const [hi, lo] = [luminance(top), luminance(base)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
