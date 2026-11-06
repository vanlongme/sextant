import * as monaco from "monaco-editor/editor/editor.api";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import "monaco-editor/languages/definitions/yaml/register";

// Everything here is bundled by Vite and loaded from the app itself, never a CDN.
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

const DARK = "sextant-dark";
const LIGHT = "sextant-light";

/** A Monaco theme from the spec's color tokens. Monaco cannot read CSS variables. */
function defineTheme(
  name: string,
  base: "vs-dark" | "vs",
  t: {
    bg: string;
    surface: string;
    surface2: string;
    border: string;
    text: string;
    muted: string;
    accent: string;
    accent2: string;
    ok: string;
    info: string;
  },
): void {
  const plain = (color: string) => color.slice(1);
  monaco.editor.defineTheme(name, {
    base,
    inherit: true,
    rules: [
      { token: "", foreground: plain(t.text) },
      { token: "comment", foreground: plain(t.muted) },
      { token: "type", foreground: plain(t.accent2) },
      { token: "string", foreground: plain(t.ok) },
      { token: "number", foreground: plain(t.info) },
      { token: "keyword", foreground: plain(t.accent) },
      { token: "operators", foreground: plain(t.muted) },
      { token: "delimiter", foreground: plain(t.muted) },
    ],
    colors: {
      "editor.background": t.bg,
      "editor.foreground": t.text,
      "editor.lineHighlightBackground": t.surface2,
      "editor.lineHighlightBorder": t.surface2,
      "editor.selectionBackground": `${t.accent}55`,
      "editorCursor.foreground": t.accent,
      "editorLineNumber.foreground": t.muted,
      "editorLineNumber.activeForeground": t.text,
      "editorWidget.background": t.surface,
      "editorWidget.border": t.border,
      focusBorder: t.accent,
    },
  });
}

defineTheme(DARK, "vs-dark", {
  bg: "#0f1416",
  surface: "#161d20",
  surface2: "#1d262a",
  border: "#2a3539",
  text: "#e4ebee",
  muted: "#93a3a9",
  accent: "#d4a24c",
  accent2: "#3fb6a8",
  ok: "#4cbb7d",
  info: "#5aa7e0",
});
defineTheme(LIGHT, "vs", {
  bg: "#f6f7f5",
  surface: "#ffffff",
  surface2: "#eef1ee",
  border: "#d7dcd8",
  text: "#1b2326",
  muted: "#5b6a70",
  accent: "#a8741a",
  accent2: "#0f857a",
  ok: "#1f8a50",
  info: "#2a70ad",
});

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
