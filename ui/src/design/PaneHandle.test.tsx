import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { expect, test } from "vitest";
import { PaneHandle } from "./PaneHandle";

/** A pane of `initial` px whose handle sits on its `edge`. */
function Pane(props: { edge: "left" | "right"; initial?: number }) {
  const [width, setWidth] = useState(props.initial ?? 240);
  return (
    <PaneHandle
      label="Resize navigation"
      edge={props.edge}
      value={width}
      min={168}
      max={360}
      initial={224}
      onChange={setWidth}
      testId="pane"
    />
  );
}

const handle = () => screen.getByTestId("pane");
const now = () => Number(handle().getAttribute("aria-valuenow"));

test("is a focusable vertical separator with its bounds", () => {
  render(<Pane edge="right" />);
  const h = screen.getByRole("separator", { name: "Resize navigation" });
  expect(h.getAttribute("aria-orientation")).toBe("vertical");
  expect(h.getAttribute("aria-valuemin")).toBe("168");
  expect(h.getAttribute("aria-valuemax")).toBe("360");
  expect(h.tabIndex).toBe(0);
  expect(now()).toBe(240);
});

test("arrows move the edge they sit on; Shift takes bigger steps", () => {
  render(<Pane edge="right" />);
  fireEvent.keyDown(handle(), { key: "ArrowRight" });
  expect(now()).toBe(256);
  fireEvent.keyDown(handle(), { key: "ArrowLeft", shiftKey: true });
  expect(now()).toBe(192);
});

test("on a left edge, Left makes the pane wider", () => {
  render(<Pane edge="left" />);
  fireEvent.keyDown(handle(), { key: "ArrowLeft" });
  expect(now()).toBe(256);
  fireEvent.keyDown(handle(), { key: "ArrowRight" });
  expect(now()).toBe(240);
});

test("stays within its bounds; Home and End jump to them; double-click resets", () => {
  render(<Pane edge="right" initial={350} />);
  fireEvent.keyDown(handle(), { key: "ArrowRight", shiftKey: true });
  expect(now()).toBe(360);
  fireEvent.keyDown(handle(), { key: "Home" });
  expect(now()).toBe(168);
  fireEvent.keyDown(handle(), { key: "End" });
  expect(now()).toBe(360);
  fireEvent.doubleClick(handle());
  expect(now()).toBe(224);
});

test("dragging follows the pointer, mirrored on a left edge", () => {
  render(<Pane edge="right" />);
  fireEvent.pointerDown(handle(), { button: 0, clientX: 300, pointerId: 1 });
  fireEvent.pointerMove(handle(), { clientX: 340, pointerId: 1 });
  expect(now()).toBe(280);
  fireEvent.pointerUp(handle(), { pointerId: 1 });
  fireEvent.pointerMove(handle(), { clientX: 400, pointerId: 1 });
  expect(now()).toBe(280);
});

test("dragging a left edge to the left widens the pane", () => {
  render(<Pane edge="left" />);
  fireEvent.pointerDown(handle(), { button: 0, clientX: 600, pointerId: 1 });
  fireEvent.pointerMove(handle(), { clientX: 560, pointerId: 1 });
  expect(now()).toBe(280);
});
