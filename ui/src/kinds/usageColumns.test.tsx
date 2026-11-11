import { render, screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import type { ApiResourceInfo } from "../ipc/generated/ApiResourceInfo";
import type { UsageItem } from "../ipc/generated/UsageItem";
import { usageItem } from "../test/metrics";
import "./index";
import { type KubeObject, objectKey } from "./objects";
import { kindSpec } from "./registry";
import { NOT_SERVED_TIP, type UsageView, usageColumns } from "./usageColumns";

const WEB: KubeObject = { metadata: { name: "web", namespace: "shop" } };
const IDLE: KubeObject = { metadata: { name: "idle", namespace: "shop" } };

function view(items: UsageItem[], notServed = false): UsageView {
  return {
    items: new Map(items.map((i) => [`${i.namespace}/${i.name}`, i])),
    notServed,
  };
}

/** The CPU and Memory cells of one row. */
function cells(usage: UsageView | undefined, row: KubeObject) {
  const [cpu, memory] = usageColumns(usage, objectKey);
  render(
    <>
      {cpu.render(row)}
      {memory.render(row)}
    </>,
  );
  return {
    cpu: screen.getByTestId("usage-cpu"),
    memory: screen.getByTestId("usage-memory"),
  };
}

test("the columns are CPU and Memory", () => {
  expect(
    usageColumns(undefined, objectKey).map((c) => [c.id, c.header]),
  ).toEqual([
    ["cpu", "CPU"],
    ["memory", "Memory"],
  ]);
});

test("cells read the row's item in the kubectl top style", () => {
  const { cpu, memory } = cells(
    view([
      usageItem({ name: "web", cpuCores: 1.25, memoryBytes: 1.2 * 2 ** 30 }),
    ]),
    WEB,
  );
  expect(cpu.textContent).toBe("1250m");
  expect(memory.textContent).toBe("1.2Gi");
  expect(cpu.getAttribute("title")).toBeNull();
});

test("small values read in millicores and Mi", () => {
  const { cpu, memory } = cells(
    view([
      usageItem({ name: "web", cpuCores: 0.004, memoryBytes: 21 * 2 ** 20 }),
    ]),
    WEB,
  );
  expect(cpu.textContent).toBe("4m");
  expect(memory.textContent).toBe("21Mi");
});

test("a row with no sample, and a list with no usage, read — with no tooltip", () => {
  const read = (usage: UsageView | undefined, row: KubeObject) => {
    const [cpu] = usageColumns(usage, objectKey);
    const { container } = render(<div>{cpu.render(row)}</div>);
    const cell = within(container).getByTestId("usage-cpu");
    return [cell.textContent, cell.getAttribute("title")];
  };
  expect(read(view([usageItem({ name: "web" })]), IDLE)).toEqual(["—", null]);
  expect(read(undefined, WEB)).toEqual(["—", null]);
  expect(read({ items: null, notServed: false }, WEB)).toEqual(["—", null]);
});

test("when metrics.k8s.io is not served, cells read — with a tooltip", () => {
  const { cpu, memory } = cells(view([usageItem({ name: "web" })], true), WEB);
  expect(cpu.textContent).toBe("—");
  expect(cpu.getAttribute("title")).toBe("metrics.k8s.io is not served");
  expect(memory.getAttribute("title")).toBe(NOT_SERVED_TIP);
});

test("they sort by the number, and a cell that shows — sorts by null", () => {
  const usage = view([
    usageItem({ name: "web", cpuCores: 0.5, memoryBytes: 2 ** 26 }),
    usageItem({ name: "broken", cpuCores: Number.NaN, memoryBytes: -1 }),
  ]);
  const [cpu, memory] = usageColumns(usage, objectKey);
  const broken: KubeObject = {
    metadata: { name: "broken", namespace: "shop" },
  };
  expect(cpu.sortValue?.(WEB)).toBe(0.5);
  expect(memory.sortValue?.(WEB)).toBe(2 ** 26);
  expect(cpu.sortValue?.(IDLE)).toBeNull();
  expect(cpu.sortValue?.(broken)).toBeNull();
  expect(memory.sortValue?.(broken)).toBeNull();
  const [notServed] = usageColumns(
    view([usageItem({ name: "web" })], true),
    objectKey,
  );
  expect(notServed.sortValue?.(WEB)).toBeNull();
});

function infoFor(
  plural: string,
  kind: string,
  namespaced: boolean,
): ApiResourceInfo {
  return {
    resource: { group: "", version: "v1", plural, kind, namespaced },
    verbs: [],
    shortNames: [],
    canList: true,
    canWatch: true,
    canCreate: true,
    canUpdate: true,
    canPatch: true,
    canDelete: true,
  };
}

test("Pods and Nodes show CPU and Memory where spec §11 puts them", () => {
  const shown = (plural: string, kind: string, namespaced: boolean) =>
    (kindSpec("", plural)?.columns?.(infoFor(plural, kind, namespaced)) ?? [])
      .filter((c) => !c.defaultHidden)
      .map((c) => c.header);
  expect(shown("pods", "Pod", true)).toEqual([
    "Name",
    "Namespace",
    "Ready",
    "Status",
    "Restarts",
    "Node",
    "CPU",
    "Memory",
    "Age",
  ]);
  expect(shown("nodes", "Node", false)).toEqual([
    "Name",
    "Status",
    "Roles",
    "Version",
    "CPU",
    "Memory",
    "Internal IP",
    "Taints",
    "Age",
  ]);
});
