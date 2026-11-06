import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { FieldTree } from "./FieldTree";

test("scalars show their values, including null, booleans and numbers", () => {
  render(<FieldTree value={{ a: "text", b: 3, c: true, d: null }} />);
  expect(screen.getByText("text")).toBeTruthy();
  expect(screen.getByText("3")).toBeTruthy();
  expect(screen.getByText("true")).toBeTruthy();
  expect(screen.getByText("null")).toBeTruthy();
});

test("nested objects and arrays can be collapsed and expanded", () => {
  render(<FieldTree value={{ spec: { replicas: 2, ports: [80, 443] } }} />);
  expect(screen.getByText("replicas")).toBeTruthy();
  const spec = screen.getByRole("button", { name: "spec {2}" });
  expect(spec.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(spec);
  expect(screen.queryByText("replicas")).toBeNull();
  fireEvent.click(spec);
  expect(screen.getByText("replicas")).toBeTruthy();
  expect(screen.getByRole("button", { name: "ports [2]" })).toBeTruthy();
});

test("deep structures stay collapsed until opened", () => {
  render(<FieldTree value={{ a: { b: { c: { d: "deep" } } } }} />);
  expect(screen.queryByText("deep")).toBeNull();
  const c = screen.getByRole("button", { name: "c {1}" });
  expect(c.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(c);
  expect(screen.getByText("deep")).toBeTruthy();
});

test("empty structures and a bare null render without crashing", () => {
  const { unmount } = render(<FieldTree value={{}} />);
  expect(screen.getByText("Empty")).toBeTruthy();
  unmount();
  render(<FieldTree value={null} />);
  expect(screen.getByText("null")).toBeTruthy();
});
