import { writeText } from "@tauri-apps/plugin-clipboard-manager";

/** Puts text on the system clipboard. The app may write it, never read it. */
export function copyText(text: string): Promise<void> {
  return writeText(text);
}
