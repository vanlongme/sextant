import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import { expect, test } from "vitest";
import type { KubeObject } from "./objects";
import { columnsFromCrd, evaluateJsonPath } from "./printerColumns";

const object = {
  spec: { replicas: 3, paused: false, zero: 0, name: "web" },
  metadata: {
    labels: { "app.kubernetes.io/name": "web" },
    empty: null,
  },
  status: {
    conditions: [
      { type: "Ready", status: "True", reason: "Up" },
      { type: "Synced", status: "False", reason: "Down" },
      { type: "Ready2", status: "Unknown", count: 2 },
    ],
    addresses: [{ ip: "10.0.0.1" }, { ip: "10.0.0.2" }, {}],
    nested: { a: 1 },
    ports: [80, 443],
  },
};

test.each([
  [".spec.replicas", "3"],
  [".spec.name", "web"],
  // Falsy values are values.
  [".spec.paused", "false"],
  [".spec.zero", "0"],
  // Indexes, from either end.
  [".status.conditions[0].type", "Ready"],
  [".status.conditions[1].status", "False"],
  [".status.conditions[-1].type", "Ready2"],
  // Filters.
  ['.status.conditions[?(@.type=="Ready")].status', "True"],
  [".status.conditions[?(@.type=='Synced')].reason", "Down"],
  ['.status.conditions[?(@.type!="Ready")].type', "Synced,Ready2"],
  [".status.conditions[?(@.count==2)].type", "Ready2"],
  // Arrays join with a comma.
  [".status.ports", "80,443"],
  [".status.addresses[*].ip", "10.0.0.1,10.0.0.2"],
  [".status.addresses[].ip", "10.0.0.1,10.0.0.2"],
  [".status.addresses.ip", "10.0.0.1,10.0.0.2"],
  // Keys with dots, and braces as kubectl writes them.
  [".metadata.labels.app\\.kubernetes\\.io/name", "web"],
  [".metadata.labels['app.kubernetes.io/name']", "web"],
  ["{.spec.replicas}", "3"],
  // An object prints as JSON.
  [".status.nested", '{"a":1}'],
])("evaluates %s", (path, expected) => {
  expect(evaluateJsonPath(object, path)).toBe(expected);
});

test.each([
  ".spec.missing",
  ".nope.deeper.still",
  ".status.conditions[9].type",
  '.status.conditions[?(@.type=="Absent")].status',
  ".metadata.empty",
  ".spec.replicas.deeper",
  // Not a path this evaluator understands, which is not an error.
  ".status.conditions[?(@.type",
  ".status[",
  "",
])("gives an empty string for %j", (path) => {
  expect(evaluateJsonPath(object, path)).toBe("");
});

test("evaluates against values that are not objects", () => {
  expect(evaluateJsonPath(null, ".a")).toBe("");
  expect(evaluateJsonPath("text", ".a")).toBe("");
  expect(evaluateJsonPath(undefined, ".a")).toBe("");
});

const crd: KubeObject = {
  metadata: { name: "widgets.example.com" },
  spec: {
    versions: [
      {
        name: "v1alpha1",
        additionalPrinterColumns: [
          { name: "Old", type: "string", jsonPath: ".spec.old" },
        ],
      },
      {
        name: "v1",
        additionalPrinterColumns: [
          { name: "Size", type: "integer", jsonPath: ".spec.size" },
          { name: "Phase", type: "string", jsonPath: ".status.phase" },
          {
            name: "Detail",
            type: "string",
            jsonPath: ".status.detail",
            priority: 1,
          },
          {
            name: "Started",
            type: "date",
            jsonPath: ".status.startTime",
          },
        ],
      },
      { name: "v2" },
    ],
  },
};

const widget = (spec: object, status: object = {}): KubeObject => ({
  metadata: { name: "w" },
  spec,
  status,
});

test("columnsFromCrd uses the served version's printer columns", () => {
  const headers = columnsFromCrd(crd, "v1").map((c) => c.header);
  expect(headers).toEqual(["Size", "Phase", "Detail", "Started"]);
  expect(columnsFromCrd(crd, "v1alpha1").map((c) => c.header)).toEqual(["Old"]);
});

test("columnsFromCrd has no columns without a definition or a version", () => {
  expect(columnsFromCrd(undefined, "v1")).toEqual([]);
  expect(columnsFromCrd(crd, "v2")).toEqual([]);
  expect(columnsFromCrd(crd, "v3")).toEqual([]);
  expect(columnsFromCrd({ metadata: { name: "x" } }, "v1")).toEqual([]);
});

test("columnsFromCrd marks priority above zero as hidden by default", () => {
  const hidden = columnsFromCrd(crd, "v1")
    .filter((c) => c.defaultHidden)
    .map((c) => c.header);
  expect(hidden).toEqual(["Detail"]);
});

test("columnsFromCrd renders values and sorts numbers as numbers", () => {
  const [size, phase] = columnsFromCrd(crd, "v1");
  const object = widget({ size: 9 }, { phase: "Running" });
  expect(phase.render(object)).toBe("Running");
  expect(phase.sortValue?.(object)).toBe("Running");
  expect(size.render(object)).toBe("9");
  expect(size.sortValue?.(object)).toBe(9);
  const missing = size.sortValue?.(widget({})) as number;
  expect(missing).toBeLessThan(0);
  expect(Number.isFinite(missing)).toBe(true);
});

test("columnsFromCrd maps a date type to age format", () => {
  const started = columnsFromCrd(crd, "v1")[3];
  const threeHours = 3 * 60 * 60 * 1000;
  const iso = new Date(Date.now() - threeHours).toISOString();
  const object = widget({}, { startTime: iso });
  render(createElement("div", { "data-testid": "c" }, started.render(object)));
  expect(screen.getByTestId("c").textContent).toBe("3h");
  // A larger age sorts later, whatever the timestamp.
  const older = widget({}, { startTime: new Date(0).toISOString() });
  expect(started.sortValue?.(older) as number).toBeGreaterThan(
    started.sortValue?.(object) as number,
  );
});
