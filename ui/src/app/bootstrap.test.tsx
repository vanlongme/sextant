import { beforeEach, expect, test, vi } from "vitest";
import { toast } from "../design";
import { resetPrefsForTest } from "../stores/prefs";
import { emitEvent, mockBackend } from "../test/ipc";
import { bootstrap } from "./bootstrap";

beforeEach(() => {
  resetPrefsForTest();
  vi.restoreAllMocks();
  delete document.documentElement.dataset.theme;
});

test("the saved theme is applied on start", async () => {
  mockBackend({ prefs_get: () => ({ theme: "light", syncSources: [] }) });

  await bootstrap();

  expect(document.documentElement.dataset.theme).toBe("light");
});

test("a theme is applied even when prefs cannot be read", async () => {
  mockBackend({
    prefs_get: () => {
      throw { code: "Internal", message: "nope", details: null };
    },
  });

  await bootstrap();

  expect(document.documentElement.dataset.theme).toBeDefined();
});

test("store://warning raises a toast naming the file and the reason", async () => {
  const errors = vi.spyOn(toast, "error");
  mockBackend({ prefs_get: () => ({ theme: "dark", syncSources: [] }) });
  await bootstrap();

  await emitEvent("store://warning", {
    file: "prefs.json",
    message: "moved aside because it was corrupt",
  });

  const shown = errors.mock.calls[0]?.join(" ");
  expect(shown).toContain("prefs.json");
  expect(shown).toContain("moved aside because it was corrupt");
});
