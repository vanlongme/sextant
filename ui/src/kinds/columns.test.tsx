import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import type { ResourceRef } from "../ipc/generated/ResourceRef";
import { baseColumns, numberColumn, statusColumn, textColumn } from "./columns";

const POD: ResourceRef = {
  group: "",
  version: "v1",
  plural: "pods",
  kind: "Pod",
  namespaced: true,
};
const NODE: ResourceRef = {
  group: "",
  version: "v1",
  plural: "nodes",
  kind: "Node",
  namespaced: false,
};
const object = { metadata: { name: "x" } };

test("baseColumns puts name and namespace first and age last", () => {
  const extra = textColumn("a", "A", () => "1");
  expect(baseColumns(POD, extra).map((c) => c.id)).toEqual([
    "name",
    "namespace",
    "a",
    "age",
  ]);
  expect(baseColumns(NODE, extra).map((c) => c.id)).toEqual([
    "name",
    "a",
    "age",
  ]);
});

test("an empty text cell reads as a dash and sorts as empty", () => {
  const column = textColumn("a", "A", () => undefined);
  render(<div>{column.render(object)}</div>);
  expect(screen.getByText("-")).toBeTruthy();
  expect(column.sortValue?.(object)).toBe("");
});

test("a number column sorts numerically and treats a missing value as zero", () => {
  const column = numberColumn("n", "N", () => undefined);
  expect(column.sortValue?.(object)).toBe(0);
});

test("a status column shows a badge and sorts by its label", () => {
  const column = statusColumn(() => ({ label: "Running", tone: "ok" }));
  render(<div>{column.render(object)}</div>);
  expect(screen.getByText("Running")).toBeTruthy();
  expect(column.sortValue?.(object)).toBe("Running");
});
