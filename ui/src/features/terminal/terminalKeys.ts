import { matchesShortcut } from "../../app/shortcuts";
import { toast } from "../../design";
import { copyText, readClipboardText } from "../../design/clipboard";
import { failureMessage } from "../../ipc/client";

export type TerminalKeyAction = "copy" | "paste" | "app";

export function isMacUserAgent(userAgent: string): boolean {
  return /Macintosh|Mac OS X/.test(userAgent);
}

/** Whether the app runs on macOS, where Cmd+C and Cmd+V copy and paste. */
export const IS_MAC = isMacUserAgent(navigator.userAgent);

/** Ctrl+` with no other modifier: the app's key for the local terminal. */
export function isTerminalShortcut(event: KeyboardEvent): boolean {
  return matchesShortcut("terminal", event, IS_MAC);
}

/**
 * What a key does in a terminal besides typing, or null when it goes to the process.
 * Ctrl+`, Mod+Shift+P and Mod+, belong to the app. Copy and paste are Ctrl+Shift+C
 * and Ctrl+Shift+V, or Cmd+C and Cmd+V on macOS; the physical key decides, so they
 * work on any layout.
 */
export function terminalKeyAction(
  event: KeyboardEvent,
  mac: boolean,
): TerminalKeyAction | null {
  if (
    isTerminalShortcut(event) ||
    matchesShortcut("palette", event, mac) ||
    matchesShortcut("preferences", event, mac)
  ) {
    return "app";
  }
  const modifiers = mac
    ? event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
    : event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey;
  if (!modifiers) return null;
  if (event.code === "KeyC") return "copy";
  if (event.code === "KeyV") return "paste";
  return null;
}

/** The parts of a terminal the copy and paste keys use. */
export interface KeyTarget {
  hasSelection(): boolean;
  getSelection(): string;
  /** xterm's `paste`, which wraps the text for bracketed paste when the process asks. */
  paste(text: string): void;
  inputEnabled(): boolean;
}

function copySelection(target: KeyTarget): void {
  if (!target.hasSelection()) return;
  void copyText(target.getSelection()).catch((error: unknown) =>
    toast.error("Could not copy", failureMessage(error)),
  );
}

function pasteInto(target: KeyTarget): void {
  if (!target.inputEnabled()) return;
  void readClipboardText().then(
    (text) => {
      if (text !== "" && target.inputEnabled()) target.paste(text);
    },
    (error: unknown) => toast.error("Could not paste", failureMessage(error)),
  );
}

/**
 * xterm's custom key handler. xterm calls it for keydown, keypress and keyup; false
 * keeps xterm from handling the key. Copy and paste act on keydown only and prevent its
 * default, so the webview does not paste a second time. Ctrl+` is left to bubble up to
 * the app.
 */
export function handleTerminalKey(
  event: KeyboardEvent,
  target: KeyTarget,
  mac: boolean,
): boolean {
  const action = terminalKeyAction(event, mac);
  if (action === null) return true;
  if (action === "app" || event.type !== "keydown") return false;
  event.preventDefault();
  if (action === "copy") copySelection(target);
  else pasteInto(target);
  return false;
}
