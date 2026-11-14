import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { FilterPopover } from "./FilterPopover";

const innerHeight = window.innerHeight;
afterEach(() => {
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: innerHeight,
  });
  vi.restoreAllMocks();
});

function Harness() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  return (
    <>
      <button type="button" data-testid="elsewhere">
        elsewhere
      </button>
      <FilterPopover
        label="All namespaces"
        title="All namespaces"
        open={open}
        onOpenChange={setOpen}
        name="Namespaces"
        width={272}
        triggerTestId="trigger"
        testId="popover"
        search={{
          label: "Filter namespaces",
          value: query,
          onChange: setQuery,
          testId: "search",
        }}
        tools={<span>tools</span>}
        foot="A foot."
      >
        <ul>
          <li>row</li>
        </ul>
      </FilterPopover>
    </>
  );
}

test("the trigger opens a labelled, non-modal dialog and focuses its search", () => {
  render(<Harness />);
  const trigger = screen.getByTestId("trigger");
  expect(trigger.textContent).toBe("All namespaces");
  expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(trigger.getAttribute("title")).toBe("All namespaces");
  fireEvent.click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  const dialog = screen.getByRole("dialog", { name: "Namespaces" });
  expect(dialog.getAttribute("data-testid")).toBe("popover");
  expect(dialog.getAttribute("aria-modal")).toBeNull();
  expect(dialog.style.width).toBe("272px");
  const search = screen.getByTestId("search");
  expect(document.activeElement).toBe(search);
  expect(search.getAttribute("placeholder")).toBe("Filter namespaces");
  expect(search.getAttribute("aria-label")).toBe("Filter namespaces");
  expect(screen.getByText("A foot.")).toBeTruthy();
});

test("Escape closes it and gives focus back to the trigger", () => {
  render(<Harness />);
  fireEvent.click(screen.getByTestId("trigger"));
  fireEvent.keyDown(screen.getByTestId("search"), { key: "Escape" });
  expect(screen.queryByTestId("popover")).toBeNull();
  expect(document.activeElement).toBe(screen.getByTestId("trigger"));
});

test("a pointer down outside closes it, and one inside does not", () => {
  render(<Harness />);
  fireEvent.click(screen.getByTestId("trigger"));
  fireEvent.pointerDown(screen.getByText("row"));
  expect(screen.getByTestId("popover")).toBeTruthy();
  fireEvent.pointerDown(screen.getByTestId("elsewhere"));
  expect(screen.queryByTestId("popover")).toBeNull();
});

test("the panel is no taller than the room under the trigger, less 16 px", () => {
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: 600,
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 70,
    top: 70,
    left: 0,
    right: 120,
    bottom: 100,
    width: 120,
    height: 30,
    toJSON: () => ({}),
  });
  render(<Harness />);
  fireEvent.click(screen.getByTestId("trigger"));
  expect(screen.getByTestId("popover").style.maxHeight).toBe("484px");
});
