export type ThemeChoice = "system" | "dark" | "light";

const QUERY = "(prefers-color-scheme: dark)";
let stopTracking: (() => void) | undefined;

function setTheme(theme: "dark" | "light"): void {
  document.documentElement.dataset.theme = theme;
}

/** Sets `data-theme` on <html>; with "system" it follows prefers-color-scheme live. */
export function applyTheme(choice: ThemeChoice): void {
  stopTracking?.();
  stopTracking = undefined;
  if (choice !== "system") {
    setTheme(choice);
    return;
  }
  const mq = window.matchMedia(QUERY);
  const sync = () => setTheme(mq.matches ? "dark" : "light");
  sync();
  mq.addEventListener("change", sync);
  stopTracking = () => mq.removeEventListener("change", sync);
}
