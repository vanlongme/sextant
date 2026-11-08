import { fireEvent, render, screen } from "@testing-library/react";
import { Circle, FileCode } from "lucide-react";
import { expect, test, vi } from "vitest";
import { ObjectActionBar } from "./ObjectActionBar";
import type { ObjectActionItem } from "./objectActions";

const item = (
  id: string,
  over: Partial<ObjectActionItem> = {},
): ObjectActionItem => ({
  id,
  label: id,
  icon: Circle,
  danger: false,
  disabled: false,
  top: false,
  run: () => {},
  ...over,
});

test("a top item is an icon button named by its label", () => {
  const run = vi.fn();
  render(
    <ObjectActionBar
      items={[
        item("edit", { label: "Edit YAML", icon: FileCode, top: true, run }),
      ]}
    />,
  );
  const group = screen.getByRole("group", { name: "Actions" });
  expect(group.getAttribute("data-testid")).toBe("detail-actions");
  const button = screen.getByRole("button", { name: "Edit YAML" });
  expect(button.getAttribute("data-testid")).toBe("detail-action-edit");
  fireEvent.click(button);
  expect(run).toHaveBeenCalledTimes(1);
});

test("More actions lists every item, top ones included, in order", () => {
  render(
    <ObjectActionBar
      items={[
        item("edit", { top: true }),
        item("scale"),
        item("delete", { danger: true }),
      ]}
    />,
  );
  const more = screen.getByTestId("detail-more-actions");
  expect(more.getAttribute("aria-label")).toBe("More actions");
  expect(more.getAttribute("title")).toBe("More actions");
  fireEvent.keyDown(more, { key: "Enter" });
  expect(
    screen.getAllByRole("menuitem").map((m) => m.getAttribute("data-testid")),
  ).toEqual(["menu-item-edit", "menu-item-scale", "menu-item-delete"]);
});

test("there is no More actions when every item is a top item", () => {
  render(<ObjectActionBar items={[item("edit", { top: true })]} />);
  expect(screen.queryByTestId("detail-more-actions")).toBeNull();
});

test("a disabled top item cannot be pressed", () => {
  const run = vi.fn();
  render(
    <ObjectActionBar
      items={[item("edit", { top: true, disabled: true, run })]}
    />,
  );
  const button = screen.getByTestId("detail-action-edit") as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  fireEvent.click(button);
  expect(run).not.toHaveBeenCalled();
});
