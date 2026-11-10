import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { Switch } from "./Switch";

const input = (name: string) =>
  screen.getByRole("switch", { name }) as HTMLInputElement;

test("a native checkbox with the switch role, named by its label on the right", () => {
  render(<Switch label="Follow" checked onChange={() => {}} testId="follow" />);
  expect(input("Follow").type).toBe("checkbox");
  expect(input("Follow").checked).toBe(true);
  const label = screen.getByTestId("follow");
  expect(label.tagName).toBe("LABEL");
  expect(label.dataset.checked).toBe("true");
  expect(label.textContent).toBe("Follow");
  expect(label.lastElementChild?.textContent).toBe("Follow");
});

test("clicking reports the new state", () => {
  const onChange = vi.fn();
  render(<Switch label="Wrap" checked={false} onChange={onChange} />);
  fireEvent.click(input("Wrap"));
  expect(onChange).toHaveBeenCalledWith(true);
});

test("a disabled switch cannot be changed", () => {
  const onChange = vi.fn();
  render(
    <Switch
      label="Previous"
      checked={false}
      disabled
      onChange={onChange}
      testId="previous"
    />,
  );
  expect(input("Previous").disabled).toBe(true);
  fireEvent.click(input("Previous"));
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.getByTestId("previous").dataset.disabled).toBe("true");
});

test("md is the default size and sm is the toolbar one", () => {
  render(
    <>
      <Switch label="A" checked={false} onChange={() => {}} testId="a" />
      <Switch
        label="B"
        checked={false}
        onChange={() => {}}
        size="sm"
        testId="b"
      />
    </>,
  );
  expect(screen.getByTestId("a").classList.contains("md")).toBe(true);
  expect(screen.getByTestId("b").classList.contains("sm")).toBe(true);
});

test("a description shows under the label and describes the switch", () => {
  render(
    <Switch
      label="Create the namespace"
      description="--create-namespace"
      checked={false}
      onChange={() => {}}
      testId="create"
    />,
  );
  const box = input("Create the namespace");
  const description = screen.getByText("--create-namespace");
  expect(box.getAttribute("aria-describedby")).toBe(description.id);
  expect(description.classList.contains("description")).toBe(true);
  expect(screen.getByTestId("create").textContent).toBe(
    "Create the namespace--create-namespace",
  );
});
