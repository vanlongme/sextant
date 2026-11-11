import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import type { Platform } from "../../app/shortcuts";
import { resetShellForTest, useShell } from "../../stores/shell";
import { footerNote, ShortcutsBody, ShortcutsDialog } from "./ShortcutsDialog";

function body(platform: Platform): void {
  render(<ShortcutsBody platform={platform} onClose={() => {}} />);
}

function chips(id: string): string[] {
  return [...screen.getByTestId(`shortcut-${id}`).querySelectorAll("kbd")].map(
    (k) => k.textContent ?? "",
  );
}

function rows(): string[] {
  return screen
    .queryAllByTestId(/^shortcut-/)
    .map((r) => r.getAttribute("data-testid") ?? "");
}

function groups(): string[] {
  return screen
    .queryAllByRole("heading", { level: 3 })
    .map((h) => h.textContent ?? "");
}

function filter(text: string): void {
  fireEvent.change(screen.getByTestId("shortcuts-filter"), {
    target: { value: text },
  });
}

beforeEach(() => {
  resetShellForTest();
});

test("the groups and rows follow the table, with words off macOS", () => {
  body("linux");

  expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(
    "Keyboard shortcuts",
  );
  expect(groups()).toEqual([
    "General",
    "Navigation",
    "Command palette",
    "Dock and terminal",
    "Dialogs and lists",
    "Charts",
  ]);
  expect(rows()).toEqual([
    "shortcut-palette",
    "shortcut-shortcuts",
    "shortcut-preferences",
    "shortcut-close",
    "shortcut-back",
    "shortcut-forward",
    "shortcut-mouse",
    "shortcut-terminal",
    "shortcut-palette-move",
    "shortcut-palette-run",
    "shortcut-dock-move",
    "shortcut-terminal-copy",
    "shortcut-terminal-paste",
    "shortcut-focus",
    "shortcut-press",
    "shortcut-chartSample",
    "shortcut-chartEnds",
    "shortcut-chartHide",
  ]);
  expect(chips("palette")).toEqual(["Ctrl+Shift+P"]);
  expect(chips("shortcuts")).toEqual(["Ctrl+/"]);
  expect(chips("preferences")).toEqual(["Ctrl+,"]);
  expect(chips("close")).toEqual(["Esc"]);
  expect(chips("back")).toEqual(["Alt+Left"]);
  expect(chips("terminal")).toEqual(["Ctrl+`"]);
  expect(chips("dock-move")).toEqual([
    "Ctrl+Shift+PageUp",
    "Ctrl+Shift+PageDown",
  ]);
  expect(chips("terminal-copy")).toEqual(["Ctrl+Shift+C"]);
  expect(chips("chartSample")).toEqual(["Left", "Right"]);
  expect(chips("chartEnds")).toEqual(["Home", "End"]);
  expect(chips("chartHide")).toEqual(["Esc"]);
  expect(screen.getByTestId("shortcut-focus").textContent).toBe(
    "Move between controlsTab/Shift+Tab",
  );
});

test("on macOS the keys use symbols, and alternatives read or", () => {
  body("macos");

  expect(screen.getByTestId("shortcut-back").textContent).toBe("Back⌥←or⌘[");
  expect(chips("forward")).toEqual(["⌥→", "⌘]"]);
  expect(chips("palette")).toEqual(["⌘⇧P"]);
  expect(chips("terminal")).toEqual(["⌃`"]);
  expect(chips("terminal-copy")).toEqual(["⌘C"]);
  expect(chips("palette-move")).toEqual(["↑", "↓"]);
  expect(chips("focus")).toEqual(["Tab", "⇧Tab"]);
  expect(chips("chartSample")).toEqual(["←", "→"]);
  expect(screen.getByTestId("shortcut-chartSample").textContent).toBe(
    "Previous or next sample←/→",
  );
  expect(screen.getByTestId("shortcut-mouse").textContent).toBe(
    "Back and forward with the mouseMouse 4/Mouse 5",
  );
});

test("the filter matches the action, the group or the keys, ignoring case", () => {
  body("linux");

  filter("PASTE");
  expect(rows()).toEqual(["shortcut-terminal-paste"]);
  expect(groups()).toEqual(["Dock and terminal"]);

  filter("navigation");
  expect(rows()).toEqual([
    "shortcut-back",
    "shortcut-forward",
    "shortcut-mouse",
    "shortcut-terminal",
  ]);

  filter("shift+tab");
  expect(rows()).toEqual(["shortcut-focus"]);
});

test("the filter finds the Charts group by its name", () => {
  body("linux");

  filter("charts");

  expect(groups()).toEqual(["Charts"]);
  expect(rows()).toEqual([
    "shortcut-chartSample",
    "shortcut-chartEnds",
    "shortcut-chartHide",
  ]);
});

test("on macOS the filter reads the symbols", () => {
  body("macos");

  filter("⌘]");

  expect(rows()).toEqual(["shortcut-forward"]);
});

test("no match says so", () => {
  body("linux");

  filter("  zzz ");

  expect(screen.getByTestId("shortcuts-empty").textContent).toBe(
    'No shortcut matches "zzz".',
  );
  expect(groups()).toEqual([]);
});

test("the note names the platform", () => {
  expect([
    footerNote("macos"),
    footerNote("windows"),
    footerNote("linux"),
  ]).toEqual([
    "Shown for macOS.",
    "Shown for Windows. On macOS, Ctrl in most shortcuts is ⌘ and Alt is ⌥.",
    "Shown for Linux. On macOS, Ctrl in most shortcuts is ⌘ and Alt is ⌥.",
  ]);
  body("windows");
  expect(
    screen.getByText(
      "Shown for Windows. On macOS, Ctrl in most shortcuts is ⌘ and Alt is ⌥.",
    ),
  ).toBeTruthy();
});

test("the dialog opens with the focus in the filter, and Close gives it back", async () => {
  render(
    <>
      <button type="button" data-testid="opener">
        opener
      </button>
      <ShortcutsDialog />
    </>,
  );
  screen.getByTestId("opener").focus();

  act(() => useShell.getState().open("shortcuts"));

  const dialog = await screen.findByRole("dialog", {
    name: "Keyboard shortcuts",
  });
  expect(dialog.getAttribute("data-testid")).toBe("shortcuts-dialog");
  expect(dialog.hasAttribute("data-shell-dialog")).toBe(true);
  expect(document.activeElement).toBe(screen.getByTestId("shortcuts-filter"));
  expect(
    screen.getByTestId("shortcuts-filter").getAttribute("aria-label"),
  ).toBe("Filter");

  fireEvent.click(screen.getByRole("button", { name: "Close" }));

  await waitFor(() =>
    expect(screen.queryByTestId("shortcuts-dialog")).toBeNull(),
  );
  expect(useShell.getState().dialog).toBeNull();
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByTestId("opener")),
  );
});
