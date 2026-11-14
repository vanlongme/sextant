import { expect, test } from "vitest";
import { CLUSTER_PALETTE } from "../app/clusterVisual";
import { CSS_FILES, contrast, cssRules, themeTokens } from "../test/css";

const TEXT = [
  "--text-primary",
  "--text-secondary",
  "--text-accent",
  "--text-link",
  "--text-danger",
  "--status-nominal-text",
  "--status-warning-text",
  "--status-critical-text",
  "--status-neutral-text",
];
const SURFACES = ["--surface-page", "--surface-card", "--surface-sunken"];
const BADGES: [string, string][] = [
  ["--status-nominal-text", "--status-nominal-soft"],
  ["--status-warning-text", "--status-warning-soft"],
  ["--status-critical-text", "--status-critical-soft"],
  ["--status-neutral-text", "--status-neutral-soft"],
  ["--text-on-accent-soft", "--surface-accent-soft"],
];
const SELECTED = ["--text-primary", "--text-secondary", "--text-accent"];

for (const theme of ["light", "dark"] as const) {
  const t = themeTokens(theme);
  const v = (name: string) => {
    const value = t.get(name);
    if (!value) throw new Error(`${name} is not defined in ${theme}`);
    return value;
  };
  const card = v("--surface-card");

  test.each(TEXT.flatMap((fg) => SURFACES.map((bg) => [fg, bg])))(
    `${theme}: %s on %s reaches 4.5:1`,
    (fg, bg) => {
      expect(contrast(v(fg), v(bg), card)).toBeGreaterThanOrEqual(4.5);
    },
  );

  test.each(BADGES)(`${theme}: badge %s on %s reaches 4.5:1`, (fg, bg) => {
    expect(contrast(v(fg), v(bg), card)).toBeGreaterThanOrEqual(4.5);
  });

  test.each(SELECTED)(`${theme}: %s on a selected row reaches 4.5:1`, (fg) => {
    expect(
      contrast(v(fg), v("--surface-selected"), card),
    ).toBeGreaterThanOrEqual(4.5);
  });

  test(`${theme}: the chart series reaches 3:1 on cards`, () => {
    expect(contrast(v("--chart-series"), card)).toBeGreaterThanOrEqual(3);
  });

  test(`${theme}: text on filled buttons reaches 4.5:1`, () => {
    expect(
      contrast(v("--text-on-accent"), v("--surface-accent")),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(v("--text-on-accent"), v("--status-critical")),
    ).toBeGreaterThanOrEqual(4.5);
  });
}

test("the dark theme keeps the design system's own danger and warning text", () => {
  const dark = themeTokens("dark");
  expect(dark.get("--text-danger")).toBe("#ff8088");
  expect(dark.get("--status-warning-text")).toBe("#ffc178");
});

test("the chart series is the accent, one step lighter in the dark theme", () => {
  expect(themeTokens("light").get("--chart-series")).toBe("#0b57e3");
  expect(themeTokens("dark").get("--chart-series")).toBe("#4f80fb");
});

test.each(CLUSTER_PALETTE)("white initials on %s reach 3:1", (colour) => {
  expect(contrast("#ffffff", colour)).toBeGreaterThanOrEqual(3);
});

/** `#rrggbb` or `rgba(r, g, b, a)` as channels and alpha. */
function channels(colour: string): [number, number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(colour);
  if (hex) {
    const n = Number.parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const [r, g, b, a = 1] = (/\(([^)]+)\)/.exec(colour)?.[1] ?? "")
    .split(",")
    .map((x) => Number(x.trim()));
  return [r, g, b, a];
}

const hexOf = (rgb: number[]) =>
  `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

test.each(["light", "dark"] as const)(
  "%s: text on the card under the drawer's dim reaches 4.5:1",
  (theme) => {
    const t = themeTokens(theme);
    const rules = cssRules(
      CSS_FILES["/src/features/details/DetailDrawer.module.css"],
    );
    const selector =
      theme === "dark" ? ':global([data-theme="dark"]) .dim' : ".dim";
    const opacity = Number(
      Object.fromEntries(
        rules.find((r) => r.selector === selector)?.decls ?? [],
      ).opacity,
    );
    expect(opacity).toBeGreaterThan(0);
    const [sr, sg, sb, sa] = channels(t.get("--scrim") ?? "");
    const a = sa * opacity;
    // Text and card both sit under the dim.
    const veil = (colour: string) => {
      const [r, g, b] = channels(colour);
      return hexOf([
        sr * a + r * (1 - a),
        sg * a + g * (1 - a),
        sb * a + b * (1 - a),
      ]);
    };
    const card = veil(t.get("--surface-card") ?? "");
    for (const fg of ["--text-primary", "--text-secondary"]) {
      expect([fg, contrast(veil(t.get(fg) ?? ""), card) >= 4.5]).toEqual([
        fg,
        true,
      ]);
    }
  },
);
