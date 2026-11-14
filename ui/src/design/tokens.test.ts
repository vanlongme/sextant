import { expect, test } from "vitest";
import { CSS_FILES, declaredNames, varNames } from "../test/css";

// Names from the token file this restyle replaced (spec §4.3).
const OLD = new Set([
  "--bg",
  "--surface",
  "--surface-2",
  "--border",
  "--text",
  "--text-muted",
  "--accent",
  "--accent-2",
  "--ok",
  "--warn",
  "--danger",
  "--info",
  "--radius",
  "--font-ui",
  "--font-size",
  "--shadow-overlay",
  "--overlay-scrim",
  "--on-accent",
]);
// Set at run time: by Radix on its popovers, and by VirtualTable's inline style.
const RUNTIME = ["--vt-columns", "--vt-min-width"];
const RUNTIME_PREFIX = "--radix-";

// What every stylesheet may use: the tokens, the base layer and the run-time names.
// Anything else must be defined in the same file (spec §8).
const shared = new Set([
  ...declaredNames(CSS_FILES["/src/design/tinyorbit.css"] ?? ""),
  ...declaredNames(CSS_FILES["/src/design/global.css"] ?? ""),
  ...RUNTIME,
]);

test("the old token file is gone and the TinyOrbit one is loaded", () => {
  expect(Object.keys(CSS_FILES)).not.toContain("/src/design/tokens.css");
  expect(CSS_FILES["/src/design/global.css"]).toContain(
    '@import "./tinyorbit.css";',
  );
});

test.each(Object.entries(CSS_FILES))("%s uses no old token name", (_, css) => {
  const used = [...varNames(css), ...declaredNames(css)];
  expect(used.filter((n) => OLD.has(n))).toEqual([]);
});

test.each(Object.entries(CSS_FILES))(
  "%s uses only custom properties that are defined",
  (_, css) => {
    const own = new Set(declaredNames(css));
    const missing = varNames(css).filter(
      (n) => !shared.has(n) && !own.has(n) && !n.startsWith(RUNTIME_PREFIX),
    );
    expect(missing).toEqual([]);
  },
);

test.each(Object.entries(CSS_FILES))(
  "%s loads nothing from a network and draws no gradient but a flat tint",
  (_, css) => {
    expect(css).not.toMatch(/@import\s+url\(\s*["']?https?:/);
    expect(css).not.toMatch(/fonts\.googleapis|fonts\.gstatic/);
    // `linear-gradient(var(--x), var(--x))` is one flat colour over a base (spec H68).
    const flat = css.replace(
      /linear-gradient\(\s*(var\(--[a-z-]+\)),\s*\1\s*\)/g,
      "",
    );
    expect(flat).not.toMatch(/gradient\(/);
  },
);
