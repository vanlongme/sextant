import * as monaco from "monaco-editor/editor/editor.api";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import "monaco-editor/languages/definitions/yaml/register";
// editor.api carries no commands. These add what a person expects of a text
// editor: word navigation (Option/Ctrl+Arrow), line and comment commands, and find.
import "monaco-editor/editor/contrib/wordOperations/browser/wordOperations";
import "monaco-editor/editor/contrib/linesOperations/browser/linesOperations";
import "monaco-editor/editor/contrib/comment/browser/comment";
import "monaco-editor/editor/contrib/find/browser/findController";
import { PALETTE, type Palette } from "../../design/palette";

// Everything here is bundled by Vite and loaded from the app itself, never a CDN.
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

const DARK = "skopos-dark";
const LIGHT = "skopos-light";

/** A Monaco theme from the design tokens. Monaco cannot read CSS variables. */
function defineTheme(name: string, base: "vs-dark" | "vs", p: Palette): void {
  const plain = (color: string) => color.slice(1);
  monaco.editor.defineTheme(name, {
    base,
    inherit: true,
    rules: [
      { token: "", foreground: plain(p.textPrimary) },
      { token: "comment", foreground: plain(p.textTertiary) },
      { token: "type", foreground: plain(p.key) },
      { token: "string", foreground: plain(p.string) },
      { token: "number", foreground: plain(p.number) },
      { token: "keyword", foreground: plain(p.number) },
      { token: "operators", foreground: plain(p.textSecondary) },
      { token: "delimiter", foreground: plain(p.textSecondary) },
    ],
    colors: {
      "editor.background": p.surfaceCard,
      "editor.foreground": p.textPrimary,
      "editor.lineHighlightBackground": p.surfaceSunken,
      "editor.lineHighlightBorder": p.surfaceSunken,
      "editor.selectionBackground": `${p.accent}33`,
      "editorCursor.foreground": p.accent,
      "editorLineNumber.foreground": p.textTertiary,
      "editorLineNumber.activeForeground": p.textPrimary,
      "editorWidget.background": p.surfaceCard,
      "editorWidget.border": p.border,
      focusBorder: p.accent,
    },
  });
}

defineTheme(DARK, "vs-dark", PALETTE.dark);
defineTheme(LIGHT, "vs", PALETTE.light);

/** The Monaco theme that goes with the app's `data-theme`. */
export function currentTheme(): string {
  return document.documentElement.dataset.theme === "light" ? LIGHT : DARK;
}

new MutationObserver(() => monaco.editor.setTheme(currentTheme())).observe(
  document.documentElement,
  { attributes: true, attributeFilter: ["data-theme"] },
);

if (import.meta.env.VITE_E2E) {
  // E2E sets editor content through Monaco's model API.
  (window as unknown as { monaco: typeof monaco }).monaco = monaco;
}

export { monaco };
