import { expect, test, vi } from "vitest";
import { installHistoryShortcuts } from "./history";

function key(init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { cancelable: true, ...init });
  window.dispatchEvent(e);
  return e;
}

function mouse(button: number): MouseEvent {
  const e = new MouseEvent("mouseup", { button, cancelable: true });
  window.dispatchEvent(e);
  return e;
}

test("each shortcut navigates by the right delta", () => {
  const navigate = vi.fn();
  const remove = installHistoryShortcuts(navigate, false);
  key({ key: "ArrowLeft", altKey: true });
  key({ key: "ArrowRight", altKey: true });
  mouse(3);
  mouse(4);
  expect(navigate.mock.calls).toEqual([[-1], [1], [-1], [1]]);
  remove();
});

test("on macOS Cmd+[ and Cmd+] navigate as well", () => {
  const navigate = vi.fn();
  const remove = installHistoryShortcuts(navigate, true);
  key({ key: "ArrowLeft", altKey: true });
  key({ key: "[", metaKey: true });
  key({ key: "]", metaKey: true });
  expect(navigate.mock.calls).toEqual([[-1], [-1], [1]]);
  remove();
});

test("off macOS the Meta key with [ and ] does nothing", () => {
  const navigate = vi.fn();
  const remove = installHistoryShortcuts(navigate, false);
  key({ key: "[", metaKey: true });
  key({ key: "]", metaKey: true });
  expect(navigate).not.toHaveBeenCalled();
  remove();
});

test("other keys and buttons do nothing", () => {
  const navigate = vi.fn();
  const remove = installHistoryShortcuts(navigate);
  expect(key({ key: "ArrowLeft" }).defaultPrevented).toBe(false);
  key({ key: "[" });
  key({ key: "a", altKey: true });
  mouse(0);
  mouse(1);
  expect(navigate).not.toHaveBeenCalled();
  remove();
});

test("cleanup removes the listeners", () => {
  const navigate = vi.fn();
  const remove = installHistoryShortcuts(navigate);
  remove();
  key({ key: "ArrowLeft", altKey: true });
  mouse(3);
  expect(navigate).not.toHaveBeenCalled();
});

test("keys typed into text fields and the editor are left alone", () => {
  const navigate = vi.fn();
  const remove = installHistoryShortcuts(navigate);
  const input = document.createElement("input");
  const editor = document.createElement("div");
  editor.className = "monaco-editor";
  const inner = document.createElement("textarea");
  editor.append(inner);
  document.body.append(input, editor);
  for (const target of [input, inner]) {
    const e = new KeyboardEvent("keydown", {
      key: "ArrowLeft",
      altKey: true,
      cancelable: true,
      bubbles: true,
    });
    target.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  }
  expect(navigate).not.toHaveBeenCalled();
  input.remove();
  editor.remove();
  remove();
});
