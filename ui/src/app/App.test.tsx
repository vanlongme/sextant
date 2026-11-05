import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { App } from "./App";

test("renders the app root", () => {
  render(<App />);
  expect(screen.getByTestId("app-root")).toBeTruthy();
});
