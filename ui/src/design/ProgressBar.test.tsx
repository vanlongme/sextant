import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { CSS_FILES, cssRules } from "../test/css";
import { ProgressBar } from "./ProgressBar";

test("a known value is the bar's aria-valuenow and the fill's width", () => {
  render(<ProgressBar label="Downloading helm" value={42.4} testId="bar" />);
  const bar = screen.getByRole("progressbar", { name: "Downloading helm" });
  expect(bar.getAttribute("data-testid")).toBe("bar");
  expect(bar.getAttribute("aria-valuemin")).toBe("0");
  expect(bar.getAttribute("aria-valuemax")).toBe("100");
  expect(bar.getAttribute("aria-valuenow")).toBe("42");
  expect(bar.hasAttribute("data-indeterminate")).toBe(false);
  expect((bar.firstElementChild as HTMLElement).style.width).toBe("42%");
});

test("values outside 0 to 100 are clamped", () => {
  render(
    <>
      <ProgressBar label="Low" value={-5} />
      <ProgressBar label="High" value={250} />
    </>,
  );
  const now = (name: string) =>
    screen.getByRole("progressbar", { name }).getAttribute("aria-valuenow");
  expect(now("Low")).toBe("0");
  expect(now("High")).toBe("100");
});

test("an unknown value is indeterminate: no aria-valuenow and a moving bar", () => {
  render(<ProgressBar label="Unpacking helm" value={null} />);
  const bar = screen.getByRole("progressbar", { name: "Unpacking helm" });
  expect(bar.hasAttribute("aria-valuenow")).toBe(false);
  expect(bar.getAttribute("data-indeterminate")).toBe("true");
  const fill = bar.firstElementChild as HTMLElement;
  expect(fill.classList.contains("moving")).toBe(true);
  expect(fill.style.width).toBe("");
});

test("the bar is drawn with tokens only", () => {
  const rules = cssRules(CSS_FILES["/src/design/ProgressBar.module.css"] ?? "");
  const colors = rules.flatMap((r) =>
    r.decls.filter(([p]) => p === "background" || p === "color"),
  );
  expect(colors.length).toBeGreaterThan(0);
  for (const [, value] of colors) expect(value).toMatch(/^var\(--/);
});
