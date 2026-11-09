import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { Select } from "./Select";

const OPTIONS = [
  { value: "100", label: "Last 100 lines" },
  { value: "all", label: "All lines" },
];

test("the label shows by default and names the trigger", () => {
  render(
    <Select label="Lines" value="100" options={OPTIONS} onChange={() => {}} />,
  );
  expect(screen.getByText("Lines").classList.contains("label")).toBe(true);
  const trigger = screen.getByRole("combobox", { name: "Lines" });
  expect(trigger.style.width).toBe("");
  expect(trigger.getAttribute("data-testid")).toBeNull();
});

test("a hidden label still names the trigger, which takes the width and the test id", () => {
  render(
    <Select
      label="Lines"
      hideLabel
      width={148}
      testId="logs-lines"
      value="100"
      options={OPTIONS}
      onChange={() => {}}
    />,
  );
  const trigger = screen.getByRole("combobox", { name: "Lines" });
  expect(trigger.getAttribute("data-testid")).toBe("logs-lines");
  expect(trigger.style.width).toBe("148px");
  expect(screen.getByText("Lines").classList.contains("hidden")).toBe(true);
});

test("choosing an option reports its value", async () => {
  const onChange = vi.fn();
  render(
    <Select label="Lines" value="100" options={OPTIONS} onChange={onChange} />,
  );
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Lines" }), {
    key: "Enter",
  });
  fireEvent.click(await screen.findByRole("option", { name: "All lines" }));
  expect(onChange).toHaveBeenCalledWith("all");
});
