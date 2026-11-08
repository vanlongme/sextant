import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CopyButton } from "./CopyButton";
import { copyText } from "./clipboard";

vi.mock("./clipboard", () => ({ copyText: vi.fn() }));
const copy = vi.mocked(copyText);

beforeEach(() => {
  vi.useFakeTimers();
  copy.mockReset();
  copy.mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

async function press(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
}

const advance = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

test("at rest it is named Copy <what> and has a kebab-case test id", () => {
  render(<CopyButton value={() => "1"} what="Resource version" />);
  const button = screen.getByRole("button", { name: "Copy Resource version" });
  expect(button.getAttribute("data-testid")).toBe("copy-resource-version");
  expect(button.getAttribute("title")).toBe("Copy Resource version");
  expect(button.getAttribute("data-state")).toBe("idle");
});

test("a copy says Copied for 1.4 s", async () => {
  render(<CopyButton value={() => "u-1"} what="UID" />);
  const button = screen.getByTestId("copy-uid");
  await press(button);
  expect(copy).toHaveBeenCalledWith("u-1");
  expect(button.getAttribute("aria-label")).toBe("Copied UID");
  expect(button.getAttribute("data-state")).toBe("done");
  expect(screen.getByText("Copied")).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe(
    "Copied to the clipboard",
  );
  advance(1399);
  expect(button.getAttribute("aria-label")).toBe("Copied UID");
  advance(1);
  expect(button.getAttribute("aria-label")).toBe("Copy UID");
  expect(screen.queryByText("Copied")).toBeNull();
  expect(screen.getByRole("status").textContent).toBe("");
});

test("a refused write says Clipboard blocked for 4 s", async () => {
  copy.mockRejectedValue(new Error("denied"));
  render(<CopyButton value={() => "u-1"} what="UID" />);
  const button = screen.getByTestId("copy-uid");
  await press(button);
  expect(button.getAttribute("data-state")).toBe("failed");
  expect(button.getAttribute("title")).toBe(
    "Could not copy UID; select the text instead",
  );
  expect(screen.getByText("Clipboard blocked")).toBeTruthy();
  advance(3999);
  expect(screen.getByText("Clipboard blocked")).toBeTruthy();
  advance(1);
  expect(screen.queryByText("Clipboard blocked")).toBeNull();
  expect(button.getAttribute("title")).toBe("Copy UID");
});

test("a second copy starts the 1.4 s again", async () => {
  render(<CopyButton value={() => "u-1"} what="UID" />);
  const button = screen.getByTestId("copy-uid");
  await press(button);
  advance(1000);
  await press(button);
  advance(1000);
  expect(screen.getByText("Copied")).toBeTruthy();
  advance(400);
  expect(screen.queryByText("Copied")).toBeNull();
});

test("unmounting while Copied shows leaves no timer behind", async () => {
  const { unmount } = render(<CopyButton value={() => "u-1"} what="UID" />);
  const before = vi.getTimerCount();
  await press(screen.getByTestId("copy-uid"));
  expect(vi.getTimerCount()).toBe(before + 1);
  unmount();
  expect(vi.getTimerCount()).toBe(before);
});

test("the value is read when pressed, not when drawn", async () => {
  let value = "old";
  render(<CopyButton value={() => value} what="UID" />);
  value = "new";
  await press(screen.getByTestId("copy-uid"));
  expect(copy).toHaveBeenCalledWith("new");
});

test("className goes on the button and testId overrides the default", () => {
  render(
    <CopyButton value={() => ""} what="UID" className="extra" testId="mine" />,
  );
  expect(screen.getByTestId("mine").classList.contains("extra")).toBe(true);
});
