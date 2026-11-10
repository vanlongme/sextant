import { afterEach, expect, test, vi } from "vitest";
import { installShellKeys } from "./shellKeys";

const CTRL_SHIFT_P = { key: "P", code: "KeyP", ctrlKey: true, shiftKey: true };
const CTRL_SLASH = { key: "/", code: "Slash", ctrlKey: true };
const CTRL_COMMA = { key: ",", code: "Comma", ctrlKey: true };
const CMD_SLASH = { key: "/", code: "Slash", metaKey: true };

let remove: () => void = () => {};

afterEach(() => {
  remove();
  document.body.innerHTML = "";
});

function actions() {
  return { palette: vi.fn(), shortcuts: vi.fn(), preferences: vi.fn() };
}

function press(
  init: KeyboardEventInit,
  target: EventTarget = window,
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

function calls(a: ReturnType<typeof actions>): number[] {
  return [a.palette, a.shortcuts, a.preferences].map(
    (f) => f.mock.calls.length,
  );
}

test("each shortcut runs its action and is stopped there", () => {
  const a = actions();
  remove = installShellKeys(a, false);
  const events = [press(CTRL_SHIFT_P), press(CTRL_SLASH), press(CTRL_COMMA)];
  expect(calls(a)).toEqual([1, 1, 1]);
  expect(events.map((e) => e.defaultPrevented)).toEqual([true, true, true]);
});

test("on macOS the keys use Cmd, and Ctrl is not Mod", () => {
  const a = actions();
  remove = installShellKeys(a, true);
  press({ key: "p", code: "KeyP", metaKey: true, shiftKey: true });
  press(CMD_SLASH);
  press({ key: ",", code: "Comma", metaKey: true });
  press(CTRL_SHIFT_P);
  expect(calls(a)).toEqual([1, 1, 1]);
});

test("Mod+Shift+P works from a text field before the field sees it", () => {
  const a = actions();
  remove = installShellKeys(a, false);
  const input = document.createElement("input");
  document.body.append(input);
  const field = vi.fn();
  input.addEventListener("keydown", field);
  press(CTRL_SHIFT_P, input);
  expect(a.palette).toHaveBeenCalledTimes(1);
  expect(field).not.toHaveBeenCalled();
});

test("repeats, composition and other modal dialogs are ignored", () => {
  const a = actions();
  remove = installShellKeys(a, false);
  press({ ...CTRL_SHIFT_P, repeat: true });
  press({ ...CTRL_SHIFT_P, isComposing: true });
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  document.body.append(dialog);
  press(CTRL_SHIFT_P);
  expect(a.palette).not.toHaveBeenCalled();
  // A shell dialog does not block the keys: one replaces another.
  dialog.setAttribute("data-shell-dialog", "");
  press(CTRL_SHIFT_P);
  expect(a.palette).toHaveBeenCalledTimes(1);
});

test("Mod+/ is left to Monaco everywhere and to xterm off macOS", () => {
  const editor = document.createElement("div");
  editor.className = "monaco-editor";
  const inEditor = document.createElement("textarea");
  editor.append(inEditor);
  const terminal = document.createElement("div");
  terminal.className = "xterm";
  const inTerminal = document.createElement("textarea");
  terminal.append(inTerminal);
  document.body.append(editor, terminal);

  const linux = actions();
  remove = installShellKeys(linux, false);
  const ignored = [press(CTRL_SLASH, inEditor), press(CTRL_SLASH, inTerminal)];
  expect(linux.shortcuts).not.toHaveBeenCalled();
  expect(ignored.map((e) => e.defaultPrevented)).toEqual([false, false]);
  press(CTRL_SHIFT_P, inEditor);
  press(CTRL_COMMA, inTerminal);
  expect(calls(linux)).toEqual([1, 0, 1]);
  remove();

  const mac = actions();
  remove = installShellKeys(mac, true);
  press(CMD_SLASH, inEditor);
  press(CMD_SLASH, inTerminal);
  expect(calls(mac)).toEqual([0, 1, 0]);
});

test("removing the listener stops it", () => {
  const a = actions();
  installShellKeys(a, false)();
  press(CTRL_SHIFT_P);
  expect(a.palette).not.toHaveBeenCalled();
});
