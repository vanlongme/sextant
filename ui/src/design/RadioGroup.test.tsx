import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { RadioGroup, type RadioOption } from "./RadioGroup";

type Kind = "auto" | "prometheus" | "none";

const OPTIONS: RadioOption<Kind>[] = [
  {
    value: "auto",
    label: "Detect",
    description:
      "Look for a Prometheus Service across namespaces, then fall back to metrics-server",
  },
  {
    value: "prometheus",
    label: "Prometheus",
    description: "A Service you name, queried through the API server proxy",
  },
  { value: "none", label: "None" },
];

function show(value: Kind = "auto", onChange = vi.fn()) {
  render(
    <RadioGroup
      legend="Metrics provider"
      value={value}
      options={OPTIONS}
      onChange={onChange}
      testId="settings-metrics"
    />,
  );
  return onChange;
}

const radio = (value: string) =>
  screen
    .getByTestId(`settings-metrics-${value}`)
    .querySelector("input") as HTMLInputElement;

test("a fieldset named by its legend, with one radio per option named by its label", () => {
  show();
  const group = screen.getByRole("group", { name: "Metrics provider" });
  expect(group.tagName).toBe("FIELDSET");
  expect(group.getAttribute("data-testid")).toBe("settings-metrics");
  const radios = within(group).getAllByRole("radio") as HTMLInputElement[];
  expect(radios.map((r) => r.value)).toEqual(["auto", "prometheus", "none"]);
  expect(screen.getByRole("radio", { name: "Detect" })).toBe(radios[0]);
  expect(screen.getByRole("radio", { name: "Prometheus" })).toBe(radios[1]);
  expect(screen.getByRole("radio", { name: "None" })).toBe(radios[2]);
});

test("each description sits under its label and describes its radio", () => {
  show();
  const detect = radio("auto");
  const describedBy = detect.getAttribute("aria-describedby");
  expect(describedBy).not.toBeNull();
  const description = document.getElementById(describedBy ?? "");
  expect(description?.textContent).toBe(
    "Look for a Prometheus Service across namespaces, then fall back to metrics-server",
  );
  expect(description?.classList.contains("description")).toBe(true);
  expect(screen.getByTestId("settings-metrics-auto").textContent).toBe(
    "DetectLook for a Prometheus Service across namespaces, then fall back to metrics-server",
  );
  // An option without a description is described by nothing.
  expect(radio("none").getAttribute("aria-describedby")).toBeNull();
  expect(
    screen.getByTestId("settings-metrics-none").querySelector(".description"),
  ).toBeNull();
});

test("the checked radio follows the value, and the radios share one name", () => {
  show("prometheus");
  expect(OPTIONS.map((o) => radio(o.value).checked)).toEqual([
    false,
    true,
    false,
  ]);
  const names = OPTIONS.map((o) => radio(o.value).name);
  expect(new Set(names).size).toBe(1);
  expect(names[0]).not.toBe("");
  expect(
    screen
      .getByTestId("settings-metrics-prometheus")
      .getAttribute("data-checked"),
  ).toBe("true");
  expect(
    screen.getByTestId("settings-metrics-auto").getAttribute("data-checked"),
  ).toBe("false");
});

test("two groups get different names, so the arrow keys stay inside each", () => {
  render(
    <>
      <RadioGroup
        legend="A"
        value="auto"
        options={OPTIONS}
        onChange={() => {}}
      />
      <RadioGroup
        legend="B"
        value="auto"
        options={OPTIONS}
        onChange={() => {}}
      />
    </>,
  );
  const nameOf = (legend: string) =>
    (
      within(screen.getByRole("group", { name: legend })).getAllByRole(
        "radio",
      )[0] as HTMLInputElement
    ).name;
  expect(nameOf("A")).not.toBe(nameOf("B"));
});

test("clicking an option reports its value", () => {
  const onChange = show();
  fireEvent.click(screen.getByTestId("settings-metrics-prometheus"));
  expect(onChange).toHaveBeenCalledWith("prometheus");
});

test("an arrow-key choice (a native change with no click) reports its value", () => {
  const onChange = show();
  const none = radio("none");
  none.checked = true;
  fireEvent.change(none);
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange).toHaveBeenCalledWith("none");
});

test("a native change to the value already chosen does not report", () => {
  const onChange = show();
  fireEvent.change(radio("auto"));
  expect(onChange).not.toHaveBeenCalled();
});
