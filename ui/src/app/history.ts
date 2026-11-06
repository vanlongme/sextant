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
 * Back and forward from the keyboard and the mouse: Alt+Left and Alt+Right, Cmd+[
 * and Cmd+], and mouse buttons 3 (back) and 4 (forward). Returns a function that
 * removes the listeners.
 */
export function installHistoryShortcuts(
  navigate: (delta: number) => void,
): () => void {
  function onKeyDown(e: KeyboardEvent): void {
    if (inTextField(e.target)) return;
    let delta = 0;
    if (e.altKey && !e.metaKey && !e.ctrlKey) {
      if (e.key === "ArrowLeft") delta = -1;
      else if (e.key === "ArrowRight") delta = 1;
    } else if (e.metaKey && !e.altKey && !e.ctrlKey) {
      if (e.key === "[") delta = -1;
      else if (e.key === "]") delta = 1;
    }
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
