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
  const remove = installHistoryShortcuts(navigate);
  key({ key: "ArrowLeft", altKey: true });
  key({ key: "ArrowRight", altKey: true });
  key({ key: "[", metaKey: true });
  key({ key: "]", metaKey: true });
  mouse(3);
  mouse(4);
  expect(navigate.mock.calls).toEqual([[-1], [1], [-1], [1], [-1], [1]]);
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
