import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { applyTheme } from "./theme";

type Listener = () => void;

function mockMatchMedia(initialDark: boolean) {
  let dark = initialDark;
  const listeners = new Set<Listener>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return query.includes("dark") ? dark : !dark;
    },
    media: query,
    addEventListener: (_: string, l: Listener) => listeners.add(l),
    removeEventListener: (_: string, l: Listener) => listeners.delete(l),
  }));
  return (next: boolean) => {
    dark = next;
    for (const l of [...listeners]) l();
  };
}

beforeEach(() => {
  delete document.documentElement.dataset.theme;
});
afterEach(() => vi.unstubAllGlobals());

test("applyTheme sets dark and light explicitly", () => {
  mockMatchMedia(false);
  applyTheme("dark");
  expect(document.documentElement.dataset.theme).toBe("dark");
  applyTheme("light");
  expect(document.documentElement.dataset.theme).toBe("light");
});

test("system follows prefers-color-scheme at apply time and on change", () => {
  const setDark = mockMatchMedia(true);
  applyTheme("system");
  expect(document.documentElement.dataset.theme).toBe("dark");
  setDark(false);
  expect(document.documentElement.dataset.theme).toBe("light");
  setDark(true);
  expect(document.documentElement.dataset.theme).toBe("dark");
});

test("choosing an explicit theme stops tracking the system", () => {
  const setDark = mockMatchMedia(true);
  applyTheme("system");
  applyTheme("light");
  setDark(false);
  setDark(true);
  expect(document.documentElement.dataset.theme).toBe("light");
});
