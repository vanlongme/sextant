import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Toaster, toast } from "./Toast";

const MANY_LINES = Array.from(
  { length: 200 },
  (_, i) => `default/pod-${i}: pods "pod-${i}" is forbidden`,
).join("\n");

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function dismiss(): void {
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
}

test("a long list of details scrolls inside a toast the window can hold", () => {
  render(<Toaster />);
  act(() => toast.error("Could not delete 200 of 200 Pod objects", MANY_LINES));

  const title = screen.getByText(/Could not delete 200/);
  const details = title.nextElementSibling as HTMLElement;
  expect(details.textContent).toContain("default/pod-199");
  const style = getComputedStyle(details);
  expect(style.maxHeight).not.toBe("none");
  expect(style.overflowY).toBe("auto");
  // A scrolling box a keyboard can reach, with the close button outside of it.
  expect(details.tabIndex).toBe(0);
  expect(
    details.contains(screen.getByRole("button", { name: "Dismiss" })),
  ).toBe(false);

  // Several of them together still fit: the stack itself scrolls.
  const viewport = title.closest("ol") as HTMLElement;
  expect(getComputedStyle(viewport).overflowY).toBe("auto");
  expect(getComputedStyle(viewport).maxHeight).not.toBe("none");

  dismiss();
});

test("a list of failures stays until it is dismissed", () => {
  render(<Toaster />);
  act(() => toast.error("Could not delete", "a: denied\nb: denied"));

  act(() => {
    vi.advanceTimersByTime(60_000);
  });
  expect(screen.getByText("Could not delete")).toBeTruthy();

  dismiss();
  expect(screen.queryByText("Could not delete")).toBeNull();
});

test("an error with one line of details goes away by itself", () => {
  render(<Toaster />);
  act(() => toast.error("Could not delete", "denied"));
  expect((screen.getByText("denied") as HTMLElement).tabIndex).toBe(-1);

  act(() => {
    vi.advanceTimersByTime(10_000);
  });
  expect(screen.queryByText("Could not delete")).toBeNull();
});
