import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { Segmented } from "./Segmented";

const OPTIONS = [
  { value: "system", label: "System" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

test("a radiogroup named by its label, with one radio per option in order", () => {
  render(
    <Segmented
      label="Theme"
      value="dark"
      options={OPTIONS}
      onChange={() => {}}
      testId="t"
    />,
  );
  const group = screen.getByRole("radiogroup", { name: "Theme" });
  expect(group.getAttribute("data-testid")).toBe("t");
  const radios = within(group).getAllByRole("radio") as HTMLInputElement[];
  expect(radios.map((r) => r.closest("label")?.textContent)).toEqual([
    "System",
    "Dark",
    "Light",
  ]);
  expect(radios.map((r) => r.checked)).toEqual([false, true, false]);
});

test("the radios of one control share a name, so the arrow keys move between them", () => {
  render(
    <>
      <Segmented label="A" value="dark" options={OPTIONS} onChange={() => {}} />
      <Segmented label="B" value="dark" options={OPTIONS} onChange={() => {}} />
    </>,
  );
  const names = (group: string) =>
    (
      within(screen.getByRole("radiogroup", { name: group })).getAllByRole(
        "radio",
      ) as HTMLInputElement[]
    ).map((r) => r.name);
  const a = names("A");
  expect(new Set(a).size).toBe(1);
  expect(a[0]).not.toBe("");
  expect(names("B")[0]).not.toBe(a[0]);
});

test("choosing an option reports its value, and each option has its test id", () => {
  const onChange = vi.fn();
  render(
    <Segmented
      label="Theme"
      value="dark"
      options={OPTIONS}
      onChange={onChange}
      testId="t"
    />,
  );
  expect(screen.getByTestId("t-system").textContent).toBe("System");
  fireEvent.click(screen.getByTestId("t-light"));
  expect(onChange).toHaveBeenCalledWith("light");
});
