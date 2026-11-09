import { expect, test } from "vitest";
import { contrast, themeTokens } from "../test/css";
import {
  ANSI_NAMES,
  type AnsiName,
  PALETTE,
  type Palette,
  type TerminalColors,
} from "./palette";

type Theme = "light" | "dark";
type FlatKey = Exclude<keyof Palette, "terminal">;
type TerminalKey = Exclude<keyof TerminalColors, "ansi"> | AnsiName;

const SOURCE: Record<Theme, Record<FlatKey, string>> = {
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

/** Spec §6.4: background, foreground, cursor and selection, then 16 ANSI colors from the ramps. */
const TERMINAL_SOURCE: Record<Theme, Record<TerminalKey, string>> = {
  light: {
    background: "--surface-sunken",
    foreground: "--text-primary",
    cursor: "--orbit-500",
    selection: "--surface-accent-soft",
    black: "--gray-950",
    red: "--red-700",
    green: "--green-700",
    yellow: "--signal-700",
    blue: "--orbit-500",
    magenta: "--orbit-700",
    cyan: "--orbit-400",
    white: "--gray-600",
    brightBlack: "--gray-700",
    brightRed: "--red-500",
    brightGreen: "--green-500",
    brightYellow: "--signal-700",
    brightBlue: "--orbit-600",
    brightMagenta: "--orbit-800",
    brightCyan: "--orbit-400",
    brightWhite: "--gray-500",
  },
  dark: {
    background: "--surface-sunken",
    foreground: "--text-primary",
    cursor: "--orbit-500",
    selection: "--surface-accent-soft",
    black: "--gray-500",
    red: "--red-500",
    green: "--green-500",
    yellow: "--signal-500",
    blue: "--orbit-400",
    magenta: "--orbit-500",
    cyan: "--orbit-100",
    white: "--gray-300",
    brightBlack: "--gray-400",
    brightRed: "--red-300",
    brightGreen: "--green-300",
    brightYellow: "--signal-300",
    brightBlue: "--orbit-300",
    brightMagenta: "--orbit-200",
    brightCyan: "--orbit-50",
    brightWhite: "--gray-0",
  },
};

/** `#rrggbb` stays; `rgba(r, g, b, a)` becomes `#rrggbbaa`, the form Monaco and xterm take. */
function hex(value: string): string {
  const m = value.match(/^rgba\(([^)]+)\)$/);
  if (!m) return value.toLowerCase();
  const [r, g, b, a] = m[1].split(",").map((p) => Number(p.trim()));
  const two = (n: number) => n.toString(16).padStart(2, "0");
  return `#${two(r)}${two(g)}${two(b)}${two(Math.round(a * 255))}`;
}

function terminalValue(colors: TerminalColors, key: TerminalKey): string {
  return key === "background" ||
    key === "foreground" ||
    key === "cursor" ||
    key === "selection"
    ? colors[key]
    : colors.ansi[key];
}

for (const theme of ["light", "dark"] as const) {
  const tokens = themeTokens(theme);

  test.each(Object.entries(SOURCE[theme]))(
    `${theme}: %s equals %s`,
    (key, token) => {
      const value = tokens.get(token);
      expect(value, `${token} in ${theme}`).toBeDefined();
      expect(PALETTE[theme][key as FlatKey]).toBe(hex(value as string));
    },
  );

  test.each(Object.entries(TERMINAL_SOURCE[theme]))(
    `${theme}: terminal %s equals %s`,
    (key, token) => {
      const value = tokens.get(token);
      expect(value, `${token} in ${theme}`).toBeDefined();
      expect(terminalValue(PALETTE[theme].terminal, key as TerminalKey)).toBe(
        hex(value as string),
      );
    },
  );

  test.each([...ANSI_NAMES])(
    `${theme}: ANSI %s reaches 3:1 on the terminal background`,
    (name) => {
      const { ansi, background } = PALETTE[theme].terminal;
      expect(contrast(ansi[name], background)).toBeGreaterThanOrEqual(3);
    },
  );
}

test("magenta and cyan use orbit shades other than blue's", () => {
  for (const theme of ["light", "dark"] as const) {
    const { ansi } = PALETTE[theme].terminal;
    expect(ansi.magenta).not.toBe(ansi.blue);
    expect(ansi.cyan).not.toBe(ansi.blue);
    expect(ansi.brightMagenta).not.toBe(ansi.brightBlue);
    expect(ansi.brightCyan).not.toBe(ansi.brightBlue);
  }
});
