import { expect, test } from "vitest";
import { themeTokens } from "../test/css";
import { PALETTE, type Palette } from "./palette";

const SOURCE: Record<"light" | "dark", Record<keyof Palette, string>> = {
  light: {
    surfacePage: "--surface-page",
    surfaceCard: "--surface-card",
    surfaceSunken: "--surface-sunken",
    textPrimary: "--text-primary",
    textSecondary: "--text-secondary",
    textTertiary: "--text-tertiary",
    border: "--border-subtle",
    accent: "--orbit-500",
    key: "--orbit-700",
    string: "--green-700",
    number: "--signal-700",
  },
  dark: {
    surfacePage: "--surface-page",
    surfaceCard: "--surface-card",
    surfaceSunken: "--surface-sunken",
    textPrimary: "--text-primary",
    textSecondary: "--text-secondary",
    textTertiary: "--text-tertiary",
    border: "--border-subtle",
    accent: "--orbit-500",
    key: "--orbit-300",
    string: "--green-300",
    number: "--signal-300",
  },
};

/** `#rrggbb` stays; `rgba(r, g, b, a)` becomes `#rrggbbaa`, the form Monaco takes. */
function hex(value: string): string {
  const m = value.match(/^rgba\(([^)]+)\)$/);
  if (!m) return value.toLowerCase();
  const [r, g, b, a] = m[1].split(",").map((p) => Number(p.trim()));
  const two = (n: number) => n.toString(16).padStart(2, "0");
  return `#${two(r)}${two(g)}${two(b)}${two(Math.round(a * 255))}`;
}

for (const theme of ["light", "dark"] as const) {
  const tokens = themeTokens(theme);
  test.each(Object.entries(SOURCE[theme]))(
    `${theme}: %s equals %s`,
    (key, token) => {
      const value = tokens.get(token);
      expect(value, `${token} in ${theme}`).toBeDefined();
      expect(PALETTE[theme][key as keyof Palette]).toBe(hex(value as string));
    },
  );
}
