import { IS_MAC, matchesShortcut } from "./shortcuts";

/** Whether the key is going to a place that uses these keys for editing. */
function inTextField(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (
    target.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"]), .monaco-editor',
    ) !== null
  );
}

/**
 * Back and forward from the keyboard and the mouse: the `back` and `forward` rows of
 * the shortcut table (Alt+Left and Alt+Right; also Cmd+[ and Cmd+] on macOS), and
 * mouse buttons 3 (back) and 4 (forward). Returns a function that removes the
 * listeners.
 */
export function installHistoryShortcuts(
  navigate: (delta: number) => void,
  mac = IS_MAC,
): () => void {
  function onKeyDown(e: KeyboardEvent): void {
    if (inTextField(e.target)) return;
    let delta = 0;
    if (matchesShortcut("back", e, mac)) delta = -1;
    else if (matchesShortcut("forward", e, mac)) delta = 1;
    if (delta === 0) return;
    e.preventDefault();
    navigate(delta);
  }
  function onMouseUp(e: MouseEvent): void {
    if (e.button !== 3 && e.button !== 4) return;
    e.preventDefault();
    navigate(e.button === 3 ? -1 : 1);
  }
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("mouseup", onMouseUp);
  return () => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("mouseup", onMouseUp);
  };
}
