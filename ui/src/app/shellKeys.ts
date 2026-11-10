import { matchesShortcut } from "./shortcuts";

export interface ShellKeyActions {
  palette(): void;
  shortcuts(): void;
  preferences(): void;
}

/** A modal dialog other than the three shell dialogs, which carry `data-shell-dialog`. */
const OTHER_MODAL =
  '[role="dialog"]:not([data-shell-dialog]), [role="alertdialog"]';

/** True while such a dialog is open; shell keys and macOS menu items then do nothing. */
export function otherModalOpen(): boolean {
  return document.querySelector(OTHER_MODAL) !== null;
}

function inside(target: EventTarget | null, selector: string): boolean {
  return target instanceof Element && target.closest(selector) !== null;
}

/**
 * Mod+Shift+P, Mod+/ and Mod+, (spec C §4.3). The listener sits on `window` in the
 * capture phase, so it runs before Monaco, xterm and text fields see the key.
 * Returns a function that removes it.
 */
export function installShellKeys(
  actions: ShellKeyActions,
  mac: boolean,
): () => void {
  function onKeyDown(event: KeyboardEvent): void {
    if (event.repeat || event.isComposing) return;
    if (otherModalOpen()) return;
    let action: (() => void) | null = null;
    if (matchesShortcut("palette", event, mac)) {
      action = actions.palette;
    } else if (matchesShortcut("preferences", event, mac)) {
      action = actions.preferences;
    } else if (matchesShortcut("shortcuts", event, mac)) {
      // Toggle comment in Monaco; undo in a shell. ⌘ keys never reach a terminal.
      if (inside(event.target, ".monaco-editor")) return;
      if (!mac && inside(event.target, ".xterm")) return;
      action = actions.shortcuts;
    }
    if (action === null) return;
    event.preventDefault();
    event.stopPropagation();
    action();
  }
  window.addEventListener("keydown", onKeyDown, true);
  return () => window.removeEventListener("keydown", onKeyDown, true);
}
