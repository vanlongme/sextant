/**
 * Token colours as hex, for code that cannot read CSS variables: the Monaco editor
 * now, the terminal later. palette.test.ts keeps every value equal to tinyorbit.css.
 */
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
  },
};
