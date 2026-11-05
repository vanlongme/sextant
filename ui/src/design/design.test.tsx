import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import {
  Button,
  ConfirmDialog,
  ErrorNotice,
  IconButton,
  StatusDot,
} from "./index";

test("Button shows loading state and disables itself", () => {
  render(<Button loading>Save</Button>);
  expect(
    screen.getByRole("button", { name: /save/i }).hasAttribute("disabled"),
  ).toBe(true);
});

test("IconButton exposes its label as the accessible name", () => {
  render(<IconButton label="Disconnect" icon={<span />} />);
  expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
});

test("StatusDot has an accessible label", () => {
  render(<StatusDot tone="ok" label="Connected" />);
  expect(screen.getByLabelText("Connected")).toBeTruthy();
});

test("ConfirmDialog names the target and calls back", () => {
  const onConfirm = vi.fn();
  render(
    <ConfirmDialog
      open
      title="Delete pod web-0?"
      body="This cannot be undone."
      confirmLabel="Delete"
      danger
      onConfirm={onConfirm}
      onCancel={() => {}}
    />,
  );
  expect(
    screen.getByRole("dialog", { name: "Delete pod web-0?" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  expect(onConfirm).toHaveBeenCalledOnce();
});

test("ErrorNotice shows message and retry", () => {
  const onRetry = vi.fn();
  render(
    <ErrorNotice
      title="Could not connect"
      message="connection refused"
      onRetry={onRetry}
    />,
  );
  expect(screen.getByText("connection refused")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /retry/i }));
  expect(onRetry).toHaveBeenCalledOnce();
});
