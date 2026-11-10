import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import {
  Button,
  ConfirmDialog,
  Dialog,
  ErrorNotice,
  IconButton,
  Input,
  Menu,
  StatusDot,
  Tabs,
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

test("Dialog puts its test id on the dialog", () => {
  render(
    <Dialog open onOpenChange={() => {}} title="Hello" testId="hello-dialog">
      Body
    </Dialog>,
  );
  const dialog = screen.getByTestId("hello-dialog");
  expect(dialog.getAttribute("role")).toBe("dialog");
  expect(dialog.textContent).toContain("Body");
});

test("a Menu item carries its own test id when it has one", () => {
  render(
    <Menu
      trigger={<button type="button">Open</button>}
      items={[
        { id: "a", label: "A", onSelect: () => {} },
        { id: "b", label: "B", testId: "own-b", onSelect: () => {} },
      ]}
    />,
  );
  fireEvent.keyDown(screen.getByRole("button", { name: "Open" }), {
    key: "Enter",
  });
  expect(screen.getByTestId("menu-item-a").textContent).toBe("A");
  expect(screen.getByTestId("own-b").textContent).toBe("B");
  expect(screen.queryByTestId("menu-item-b")).toBeNull();
});

test("ConfirmDialog takes a test id, its own Cancel label and a disabled confirm", () => {
  const onCancel = vi.fn();
  render(
    <ConfirmDialog
      open
      title="Stop helm?"
      body="helm stops where it is."
      confirmLabel="Stop"
      cancelLabel="Keep running"
      confirmDisabled
      danger
      testId="stop-dialog"
      onConfirm={() => {}}
      onCancel={onCancel}
    />,
  );
  expect(screen.getByTestId("stop-dialog").getAttribute("role")).toBe("dialog");
  expect(
    screen.getByRole("button", { name: "Stop" }).hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Keep running" }));
  expect(onCancel).toHaveBeenCalledOnce();
  expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
});

test("a tab with a test id carries it on its trigger", () => {
  render(
    <Tabs
      value="readme"
      onChange={() => {}}
      tabs={[
        { value: "readme", label: "README", testId: "tab-readme" },
        { value: "values", label: "Values" },
      ]}
    />,
  );
  expect(screen.getByTestId("tab-readme")).toBe(
    screen.getByRole("tab", { name: "README" }),
  );
  expect(
    screen.getByRole("tab", { name: "Values" }).hasAttribute("data-testid"),
  ).toBe(false);
});

test("an Input's help shows under it and describes it until there is an error", () => {
  const { rerender } = render(
    <Input label="Username, optional" help="For basic auth" />,
  );
  const input = screen.getByLabelText("Username, optional");
  const help = screen.getByText("For basic auth");
  expect(input.getAttribute("aria-describedby")).toBe(help.id);

  rerender(
    <Input
      label="Username, optional"
      help="For basic auth"
      error="A password needs a username"
    />,
  );
  expect(screen.queryByText("For basic auth")).toBeNull();
  expect(input.getAttribute("aria-describedby")).toBe(
    screen.getByRole("alert").id,
  );
});
