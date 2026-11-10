import { expect, test } from "vitest";
import {
  keysText,
  matchesShortcut,
  platformOf,
  SHORTCUT_GROUPS,
  SHORTCUTS,
  type ShortcutId,
  shortKeys,
} from "./shortcuts";

/** Spec C §7.2, the Keys column. */
const ELSEWHERE: Record<ShortcutId, string> = {
  palette: "Ctrl+Shift+P",
  shortcuts: "Ctrl+/",
  preferences: "Ctrl+,",
  close: "Esc",
  back: "Alt+Left",
  forward: "Alt+Right",
  mouse: "Mouse 4 / Mouse 5",
  terminal: "Ctrl+`",
  "palette-move": "Up / Down",
  "palette-run": "Enter",
  "dock-move": "Ctrl+Shift+PageUp / Ctrl+Shift+PageDown",
  "terminal-copy": "Ctrl+Shift+C",
  "terminal-paste": "Ctrl+Shift+V",
  focus: "Tab / Shift+Tab",
  press: "Enter / Space",
};

/** Spec C §7.2, the On macOS column ("same" written out). */
const MAC: Record<ShortcutId, string> = {
  palette: "⌘⇧P",
  shortcuts: "⌘/",
  preferences: "⌘,",
  close: "Esc",
  back: "⌥← or ⌘[",
  forward: "⌥→ or ⌘]",
  mouse: "Mouse 4 / Mouse 5",
  terminal: "⌃`",
  "palette-move": "↑ / ↓",
  "palette-run": "Enter",
  "dock-move": "⌃⇧PageUp / ⌃⇧PageDown",
  "terminal-copy": "⌘C",
  "terminal-paste": "⌘V",
  focus: "Tab / ⇧Tab",
  press: "Enter / Space",
};

function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", init);
}

test("the table holds the spec's rows in order", () => {
  expect(SHORTCUT_GROUPS).toEqual([
    "General",
    "Navigation",
    "Command palette",
    "Dock and terminal",
    "Dialogs and lists",
  ]);
  expect(SHORTCUTS.map((row) => [row.group, row.id, row.action])).toEqual([
    ["General", "palette", "Command palette"],
    ["General", "shortcuts", "Keyboard shortcuts"],
    ["General", "preferences", "Preferences"],
    ["General", "close", "Close the palette, dialog or menu"],
    ["Navigation", "back", "Back"],
    ["Navigation", "forward", "Forward"],
    ["Navigation", "mouse", "Back and forward with the mouse"],
    ["Navigation", "terminal", "Terminal for this cluster"],
    ["Command palette", "palette-move", "Previous or next result"],
    ["Command palette", "palette-run", "Run the selected result"],
    ["Dock and terminal", "dock-move", "Move a dock tab"],
    ["Dock and terminal", "terminal-copy", "Copy in a terminal"],
    ["Dock and terminal", "terminal-paste", "Paste in a terminal"],
    ["Dialogs and lists", "focus", "Move between controls"],
    ["Dialogs and lists", "press", "Press the focused button"],
  ]);
});

test("every row reads as the spec writes it on Windows and Linux", () => {
  const read = Object.fromEntries(
    SHORTCUTS.map((row) => [row.id, keysText(row.id, false)]),
  );
  expect(read).toEqual(ELSEWHERE);
});

test("every row reads as the spec writes it on macOS", () => {
  const read = Object.fromEntries(
    SHORTCUTS.map((row) => [row.id, keysText(row.id, true)]),
  );
  expect(read).toEqual(MAC);
});

test("short labels use the first chord", () => {
  expect([
    shortKeys("back", false),
    shortKeys("back", true),
    shortKeys("palette", true),
    shortKeys("terminal", true),
  ]).toEqual(["Alt+Left", "⌥←", "⌘⇧P", "⌃`"]);
});

test("the platform comes from the user agent", () => {
  expect([
    platformOf(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15",
    ),
    platformOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"),
    platformOf("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15"),
  ]).toEqual(["macos", "windows", "linux"]);
});

test("Mod is Ctrl off macOS and Cmd on macOS", () => {
  const ctrl = key({ key: "P", code: "KeyP", ctrlKey: true, shiftKey: true });
  const cmd = key({ key: "p", code: "KeyP", metaKey: true, shiftKey: true });
  expect([
    matchesShortcut("palette", ctrl, false),
    matchesShortcut("palette", cmd, false),
    matchesShortcut("palette", ctrl, true),
    matchesShortcut("palette", cmd, true),
  ]).toEqual([true, false, false, true]);
});

test("modifiers must match exactly", () => {
  expect([
    matchesShortcut(
      "palette",
      key({ key: "P", code: "KeyP", ctrlKey: true }),
      false,
    ),
    matchesShortcut(
      "palette",
      key({
        key: "P",
        code: "KeyP",
        ctrlKey: true,
        shiftKey: true,
        altKey: true,
      }),
      false,
    ),
    matchesShortcut(
      "preferences",
      key({ key: ",", code: "Comma", ctrlKey: true, metaKey: true }),
      false,
    ),
    matchesShortcut(
      "terminal",
      key({ key: "`", code: "Backquote", ctrlKey: true, shiftKey: true }),
      false,
    ),
  ]).toEqual([false, false, false, false]);
});

test("Shift is ignored for / and ,", () => {
  expect([
    matchesShortcut(
      "shortcuts",
      key({ key: "/", code: "Digit7", ctrlKey: true, shiftKey: true }),
      false,
    ),
    matchesShortcut(
      "preferences",
      key({ key: ",", code: "Comma", ctrlKey: true, shiftKey: true }),
      false,
    ),
  ]).toEqual([true, true]);
});

test("letters match the physical key, and the key name only without a code", () => {
  const press = (init: KeyboardEventInit) =>
    matchesShortcut(
      "palette",
      key({ ctrlKey: true, shiftKey: true, ...init }),
      false,
    );
  expect([
    press({ key: "З", code: "KeyP" }),
    press({ key: "P", code: "KeyR" }),
    press({ key: "P", code: "" }),
    press({ key: "p", code: "Unidentified" }),
  ]).toEqual([true, false, true, true]);
});

test("the terminal key is Ctrl+` on every platform", () => {
  const event = key({ key: "`", code: "Backquote", ctrlKey: true });
  expect([
    matchesShortcut("terminal", event, false),
    matchesShortcut("terminal", event, true),
  ]).toEqual([true, true]);
});

test("Cmd+[ and Cmd+] are back and forward on macOS only", () => {
  const back = key({ key: "[", metaKey: true });
  expect([
    matchesShortcut("back", key({ key: "ArrowLeft", altKey: true }), false),
    matchesShortcut("back", back, false),
    matchesShortcut("back", back, true),
    matchesShortcut("forward", key({ key: "]", metaKey: true }), true),
  ]).toEqual([true, false, true, true]);
});
