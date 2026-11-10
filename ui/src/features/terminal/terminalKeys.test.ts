import { afterEach, expect, test, vi } from "vitest";
import { toast } from "../../design";
import { flush, mockBackend } from "../../test/ipc";
import {
  handleTerminalKey,
  isMacUserAgent,
  isTerminalShortcut,
  type KeyTarget,
  terminalKeyAction,
} from "./terminalKeys";

type Keys = KeyboardEventInit & { code: string };

const CTRL_SHIFT_C: Keys = {
  code: "KeyC",
  key: "C",
  ctrlKey: true,
  shiftKey: true,
};
const CTRL_SHIFT_V: Keys = {
  code: "KeyV",
  key: "V",
  ctrlKey: true,
  shiftKey: true,
};
const CMD_C: Keys = { code: "KeyC", key: "c", metaKey: true };
const CMD_V: Keys = { code: "KeyV", key: "v", metaKey: true };
const CTRL_C: Keys = { code: "KeyC", key: "c", ctrlKey: true };
const CTRL_BACKQUOTE: Keys = { code: "Backquote", key: "`", ctrlKey: true };

afterEach(() => vi.restoreAllMocks());

function key(init: Keys, type = "keydown"): KeyboardEvent {
  return new KeyboardEvent(type, { cancelable: true, ...init });
}

function target(
  over: { selection?: string; input?: boolean } = {},
): KeyTarget & { pasted: string[] } {
  const selection = over.selection ?? "";
  const pasted: string[] = [];
  return {
    pasted,
    hasSelection: () => selection !== "",
    getSelection: () => selection,
    paste: (text) => {
      pasted.push(text);
    },
    inputEnabled: () => over.input ?? true,
  };
}

test("macOS is told apart by its user agent", () => {
  expect(
    isMacUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_1) AppleWebKit/605.1.15",
    ),
  ).toBe(true);
  expect(
    isMacUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15"),
  ).toBe(false);
  expect(
    isMacUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/131.0",
    ),
  ).toBe(false);
});

test.each<[string, Keys, boolean, string | null]>([
  ["Ctrl+Shift+C on Linux and Windows copies", CTRL_SHIFT_C, false, "copy"],
  ["Ctrl+Shift+V on Linux and Windows pastes", CTRL_SHIFT_V, false, "paste"],
  ["Cmd+C on macOS copies", CMD_C, true, "copy"],
  ["Cmd+V on macOS pastes", CMD_V, true, "paste"],
  ["Cmd+C off macOS is nothing", CMD_C, false, null],
  ["Ctrl+Shift+C on macOS is nothing", CTRL_SHIFT_C, true, null],
  ["Ctrl+C goes to the process", CTRL_C, false, null],
  ["Ctrl+C on macOS goes to the process", CTRL_C, true, null],
  ["Ctrl+` belongs to the app", CTRL_BACKQUOTE, false, "app"],
  ["Ctrl+` on macOS belongs to the app", CTRL_BACKQUOTE, true, "app"],
  [
    "Ctrl+Shift+` is nothing",
    { ...CTRL_BACKQUOTE, shiftKey: true },
    false,
    null,
  ],
  ["Ctrl+Alt+` is nothing", { ...CTRL_BACKQUOTE, altKey: true }, false, null],
])("%s", (_name, init, mac, action) => {
  expect(terminalKeyAction(key(init), mac)).toBe(action);
});

test("Ctrl+` is the terminal shortcut only without other modifiers", () => {
  expect(isTerminalShortcut(key(CTRL_BACKQUOTE))).toBe(true);
  expect(isTerminalShortcut(key({ ...CTRL_BACKQUOTE, metaKey: true }))).toBe(
    false,
  );
  expect(isTerminalShortcut(key({ ...CTRL_BACKQUOTE, ctrlKey: false }))).toBe(
    false,
  );
});

test("Ctrl+C goes to xterm, which sends it to the process", () => {
  expect(
    handleTerminalKey(key(CTRL_C), target({ selection: "x" }), false),
  ).toBe(true);
});

test("Ctrl+` is kept from xterm and left to the app", () => {
  const event = key(CTRL_BACKQUOTE);
  expect(handleTerminalKey(event, target(), false)).toBe(false);
  expect(event.defaultPrevented).toBe(false);
});

test.each<[string, Keys, boolean]>([
  ["Linux", CTRL_SHIFT_C, false],
  ["macOS", CMD_C, true],
])(
  "copy on %s writes the selection to the clipboard",
  async (_os, init, mac) => {
    const backend = mockBackend({
      "plugin:clipboard-manager|write_text": () => null,
    });
    const event = key(init);
    expect(
      handleTerminalKey(event, target({ selection: "kubectl get pods" }), mac),
    ).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    await flush();
    expect(
      backend.callsTo("plugin:clipboard-manager|write_text")[0],
    ).toMatchObject({ text: "kubectl get pods" });
  },
);

test("copy without a selection does nothing", async () => {
  const backend = mockBackend({
    "plugin:clipboard-manager|write_text": () => null,
  });
  expect(handleTerminalKey(key(CTRL_SHIFT_C), target(), false)).toBe(false);
  await flush();
  expect(backend.callsTo("plugin:clipboard-manager|write_text")).toEqual([]);
});

test.each<[string, Keys, boolean]>([
  ["Linux", CTRL_SHIFT_V, false],
  ["macOS", CMD_V, true],
])(
  "paste on %s hands the clipboard's text to xterm's paste",
  async (_os, init, mac) => {
    mockBackend({ "plugin:clipboard-manager|read_text": () => "echo hi\n" });
    const into = target();
    const event = key(init);
    expect(handleTerminalKey(event, into, mac)).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    await flush();
    expect(into.pasted).toEqual(["echo hi\n"]);
  },
);

test("paste is ignored while input is off", async () => {
  const backend = mockBackend({
    "plugin:clipboard-manager|read_text": () => "x",
  });
  const into = target({ input: false });
  expect(handleTerminalKey(key(CTRL_SHIFT_V), into, false)).toBe(false);
  await flush();
  expect(backend.callsTo("plugin:clipboard-manager|read_text")).toEqual([]);
  expect(into.pasted).toEqual([]);
});

test("only the key press acts: its keypress and keyup are kept from xterm and do nothing", async () => {
  const backend = mockBackend({
    "plugin:clipboard-manager|read_text": () => "x",
  });
  const into = target();
  expect(handleTerminalKey(key(CTRL_SHIFT_V, "keypress"), into, false)).toBe(
    false,
  );
  expect(handleTerminalKey(key(CTRL_SHIFT_V, "keyup"), into, false)).toBe(
    false,
  );
  await flush();
  expect(backend.callsTo("plugin:clipboard-manager|read_text")).toEqual([]);
});

test("a clipboard that cannot be read or written shows a toast with its message", async () => {
  const error = vi.spyOn(toast, "error");
  mockBackend({
    "plugin:clipboard-manager|read_text": () => {
      throw new Error("clipboard is locked");
    },
    "plugin:clipboard-manager|write_text": () => {
      throw new Error("no clipboard owner");
    },
  });
  handleTerminalKey(key(CTRL_SHIFT_V), target(), false);
  handleTerminalKey(key(CTRL_SHIFT_C), target({ selection: "x" }), false);
  await flush();
  expect(error).toHaveBeenCalledWith("Could not paste", "clipboard is locked");
  expect(error).toHaveBeenCalledWith("Could not copy", "no clipboard owner");
});

test("the palette and Preferences keys go to the app, not the process", () => {
  const ctrlShiftP: Keys = {
    code: "KeyP",
    key: "P",
    ctrlKey: true,
    shiftKey: true,
  };
  const ctrlComma: Keys = { code: "Comma", key: ",", ctrlKey: true };
  const cmdShiftP: Keys = {
    code: "KeyP",
    key: "p",
    metaKey: true,
    shiftKey: true,
  };
  const cmdComma: Keys = { code: "Comma", key: ",", metaKey: true };
  expect([
    terminalKeyAction(key(ctrlShiftP), false),
    terminalKeyAction(key(ctrlComma), false),
    terminalKeyAction(key(cmdShiftP), true),
    terminalKeyAction(key(cmdComma), true),
    // Off macOS, Cmd+Shift+P is not Mod+Shift+P, so the process gets it.
    terminalKeyAction(key(cmdShiftP), false),
  ]).toEqual(["app", "app", "app", "app", null]);
  expect(handleTerminalKey(key(ctrlShiftP), target(), false)).toBe(false);
  expect(handleTerminalKey(key(cmdComma), target(), true)).toBe(false);
});
