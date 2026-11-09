/**
 * Token colours as hex, for code that cannot read CSS variables: the Monaco editor and
 * the terminal. palette.test.ts keeps every value equal to tinyorbit.css.
 */

/** The 16 ANSI colours, by their names in xterm's theme. */
export const ANSI_NAMES = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

export type AnsiName = (typeof ANSI_NAMES)[number];

/**
 * The terminal's colours. TinyOrbit has no magenta or cyan hue, so those use orbit
 * shades other than blue's. Each ANSI colour reaches 3:1 on `background`.
 */
export interface TerminalColors {
  background: string;
  foreground: string;
  cursor: string;
  /** Drawn under selected text: `--surface-accent-soft`. */
  selection: string;
  ansi: Record<AnsiName, string>;
}

export interface Palette {
  surfacePage: string;
  surfaceCard: string;
  surfaceSunken: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  border: string;
  accent: string;
  /** YAML keys. */
  key: string;
  string: string;
  number: string;
  terminal: TerminalColors;
}

export const PALETTE: Record<"light" | "dark", Palette> = {
  light: {
    surfacePage: "#fafbfc",
    surfaceCard: "#ffffff",
    surfaceSunken: "#f4f6f8",
    textPrimary: "#0b0e12",
    textSecondary: "#515b67",
    textTertiary: "#6f7a87",
    border: "#0b0e1214",
    accent: "#0b57e3",
    key: "#063795",
    string: "#007344",
    number: "#b85c00",
    terminal: {
      background: "#f4f6f8",
      foreground: "#0b0e12",
      cursor: "#0b57e3",
      selection: "#edf3ff",
      ansi: {
        black: "#0b0e12",
        red: "#a80f1d",
        green: "#007344",
        yellow: "#b85c00",
        blue: "#0b57e3",
        magenta: "#063795",
        cyan: "#4f80fb",
        white: "#515b67",
        brightBlack: "#39424d",
        brightRed: "#e11d2e",
        brightGreen: "#00a15c",
        brightYellow: "#b85c00",
        brightBlue: "#0846bc",
        brightMagenta: "#052a70",
        brightCyan: "#4f80fb",
        brightWhite: "#6f7a87",
      },
    },
  },
  dark: {
    surfacePage: "#0b0e12",
    surfaceCard: "#12171d",
    surfaceSunken: "#0e1217",
    textPrimary: "#f2f5f8",
    textSecondary: "#9ba5b1",
    textTertiary: "#6f7a87",
    border: "#ffffff14",
    accent: "#0b57e3",
    key: "#8aaaff",
    string: "#3fcf8e",
    number: "#ffc178",
    terminal: {
      background: "#0e1217",
      foreground: "#f2f5f8",
      cursor: "#0b57e3",
      selection: "#0b57e329",
      ansi: {
        black: "#6f7a87",
        red: "#e11d2e",
        green: "#00a15c",
        yellow: "#f5820b",
        blue: "#4f80fb",
        magenta: "#0b57e3",
        cyan: "#dbe6ff",
        white: "#c6cdd6",
        brightBlack: "#9ba5b1",
        brightRed: "#ff8088",
        brightGreen: "#3fcf8e",
        brightYellow: "#ffc178",
        brightBlue: "#8aaaff",
        brightMagenta: "#b7ccff",
        brightCyan: "#edf3ff",
        brightWhite: "#ffffff",
      },
    },
  },
};
