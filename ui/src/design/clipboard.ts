import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";

/** Puts text on the system clipboard. */
export function copyText(text: string): Promise<void> {
  return writeText(text);
}

/** The clipboard's text. Only a terminal's paste key reads it. */
export function readClipboardText(): Promise<string> {
  return readText();
}
