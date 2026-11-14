import { render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Badge } from "./Badge";

afterEach(() => vi.restoreAllMocks());

test("a badge holds its label in an inner span and has no title while it fits", () => {
  render(<Badge tone="ok">Running</Badge>);
  const label = screen.getByText("Running");
  expect(label.tagName).toBe("SPAN");
  expect(label.parentElement?.getAttribute("title")).toBeNull();
});

test("a cut badge shows its full label as the title", () => {
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(200);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(60);
  render(<Badge tone="danger">CreateContainerConfigError</Badge>);
  expect(
    screen
      .getByText("CreateContainerConfigError")
      .parentElement?.getAttribute("title"),
  ).toBe("CreateContainerConfigError");
});
