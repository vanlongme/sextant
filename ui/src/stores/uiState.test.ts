import { act, renderHook } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { flush, mockBackend } from "../test/ipc";
import { useUiState } from "./uiState";

test("loads the saved value and saves changes after a pause", async () => {
  const backend = mockBackend({
    ui_state_get: () => ({ w: 1 }),
    ui_state_set: () => null,
  });
  const { result } = renderHook(() => useUiState("k", { w: 0 }));
  await act(flush);
  expect(result.current[0]).toEqual({ w: 1 });

  vi.useFakeTimers();
  act(() => result.current[1]({ w: 2 }));
  act(() => result.current[1]({ w: 3 }));
  expect(backend.callsTo("ui_state_set")).toEqual([]);
  act(() => {
    vi.advanceTimersByTime(300);
  });
  vi.useRealTimers();
  expect(backend.callsTo("ui_state_set")).toEqual([
    { key: "k", value: { w: 3 } },
  ]);
});

test("keeps the initial value when nothing is saved", async () => {
  mockBackend({ ui_state_get: () => null });
  const { result } = renderHook(() => useUiState("k", 5));
  await act(flush);
  expect(result.current[0]).toBe(5);
});

test("saves a pending change on unmount", async () => {
  const backend = mockBackend({
    ui_state_get: () => null,
    ui_state_set: () => null,
  });
  const { result, unmount } = renderHook(() => useUiState("k", "a"));
  await act(flush);
  act(() => result.current[1]("b"));
  unmount();
  expect(backend.callsTo("ui_state_set")).toEqual([{ key: "k", value: "b" }]);
});
