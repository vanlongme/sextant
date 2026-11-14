import { fireEvent, render, screen, within } from "@testing-library/react";
import { useMemo, useState } from "react";
import { expect, test } from "vitest";
import { countsOf, demoGraph } from "../../test/graph";
import { kindGroups } from "./filters";
import { MapFilters } from "./MapFilters";
import { buildModel, namespaceView } from "./model";

function Harness(props: { kinds?: string[] }) {
  const graph = useMemo(() => demoGraph(), []);
  const model = useMemo(() => buildModel(graph.nodes, graph.edges), [graph]);
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [kinds, setKinds] = useState<string[]>(props.kinds ?? []);
  const groups = kindGroups(model, namespaceView(model, new Set(namespaces)));
  return (
    <MapFilters
      counts={countsOf(graph.nodes)}
      hiddenNamespaces={namespaces}
      onHiddenNamespacesChange={setNamespaces}
      groups={groups}
      hiddenKinds={kinds}
      onHiddenKindsChange={setKinds}
      summary="22 resources · 3 namespaces · 16 kinds"
      summaryTitle="Every resource in the cluster"
    />
  );
}

const box = (testId: string) => screen.getByTestId(testId) as HTMLInputElement;
const optionIds = (popover: string, prefix: RegExp) =>
  within(screen.getByTestId(popover))
    .queryAllByTestId(prefix)
    .map((el) => el.getAttribute("data-testid"));

test("the Namespaces popover lists each namespace with its count, and a checkbox hides it", () => {
  render(<Harness />);
  const trigger = screen.getByTestId("map-ns-filter");
  expect(trigger.textContent).toBe("All namespaces");
  fireEvent.click(trigger);
  const popover = within(screen.getByRole("dialog", { name: "Namespaces" }));
  expect(screen.getByTestId("map-ns-popover").style.width).toBe("272px");
  expect(document.activeElement).toBe(screen.getByTestId("map-ns-search"));
  expect(
    popover
      .getAllByRole("checkbox")
      .map((c) => c.closest("label")?.textContent),
  ).toEqual(["edge1", "jobs4", "shop14"]);
  expect(popover.getByText("3 of 3")).toBeTruthy();
  expect(box("map-ns-select-all").disabled).toBe(true);
  expect(
    popover.getByText(
      "Only checked namespaces are loaded, plus what routes traffic into them.",
    ),
  ).toBeTruthy();

  fireEvent.click(box("map-ns-option-jobs"));
  expect(box("map-ns-option-jobs").checked).toBe(false);
  expect(trigger.textContent).toBe("2 namespaces");
  expect(trigger.getAttribute("title")).toBe("Namespaces: edge, shop");
  expect(popover.getByText("2 of 3")).toBeTruthy();
  expect(
    popover.getByTitle("jobs").getAttribute("class")?.split(" "),
  ).toContain("off");
});

test("the namespace search lists matching rows; Select all and Clear act on those only", () => {
  render(<Harness />);
  fireEvent.click(screen.getByTestId("map-ns-filter"));
  fireEvent.change(screen.getByTestId("map-ns-search"), {
    target: { value: "SH" },
  });
  expect(optionIds("map-ns-popover", /^map-ns-option-/)).toEqual([
    "map-ns-option-shop",
  ]);
  fireEvent.click(screen.getByTestId("map-ns-clear"));
  expect(screen.getByTestId("map-ns-filter").textContent).toBe("2 namespaces");
  expect(box("map-ns-clear").disabled).toBe(true);
  fireEvent.click(screen.getByTestId("map-ns-select-all"));
  expect(screen.getByTestId("map-ns-filter").textContent).toBe(
    "All namespaces",
  );
  fireEvent.change(screen.getByTestId("map-ns-search"), {
    target: { value: "zzz" },
  });
  expect(screen.getByText("No namespace matches.")).toBeTruthy();
});

test("the Kinds popover groups the present kinds with tri-state group boxes", () => {
  render(<Harness kinds={["ReplicaSet"]} />);
  const trigger = screen.getByTestId("map-kind-filter");
  expect(trigger.textContent).toBe("15 of 16 kinds");
  expect(trigger.getAttribute("title")).toBe("Hidden: ReplicaSets");
  fireEvent.click(trigger);
  const popover = within(screen.getByRole("dialog", { name: "Kinds" }));
  expect(screen.getByTestId("map-kind-popover").style.width).toBe("296px");
  const workloads = box("map-kind-group-workloads");
  expect(workloads.indeterminate).toBe(true);
  expect(workloads.checked).toBe(false);
  expect(workloads.getAttribute("aria-label")).toBe(
    "Workloads, some kinds shown",
  );
  expect(box("map-kind-group-config").checked).toBe(true);
  expect(box("map-kind-group-config").getAttribute("aria-label")).toBe(
    "Config, all kinds shown",
  );
  const replicaSets = box("map-kind-option-ReplicaSet");
  expect(replicaSets.checked).toBe(false);
  expect(
    replicaSets.closest("label")?.querySelector(".iconOff"),
  ).not.toBeNull();
  expect(
    box("map-kind-option-Pod").closest("label")?.querySelector(".iconOff"),
  ).toBeNull();
  expect(popover.getByText("15 of 16")).toBeTruthy();
  expect(
    popover.getByText("Links through hidden kinds show dashed."),
  ).toBeTruthy();

  fireEvent.click(workloads);
  expect(trigger.textContent).toBe("All kinds");
  fireEvent.click(box("map-kind-group-workloads"));
  expect(trigger.textContent).toBe("10 of 16 kinds");
  expect(box("map-kind-group-workloads").getAttribute("aria-label")).toBe(
    "Workloads, all kinds hidden",
  );
});

test("the kinds search matches the label, the kind or the group; the tools act on the listed rows", () => {
  render(<Harness />);
  fireEvent.click(screen.getByTestId("map-kind-filter"));
  const search = screen.getByTestId("map-kind-search");
  fireEvent.change(search, { target: { value: "network" } });
  expect(optionIds("map-kind-popover", /^map-kind-option-/)).toEqual([
    "map-kind-option-Service",
    "map-kind-option-Ingress",
    "map-kind-option-GatewayClass",
    "map-kind-option-Gateway",
    "map-kind-option-HTTPRoute",
  ]);
  fireEvent.click(screen.getByTestId("map-kind-clear"));
  expect(screen.getByTestId("map-kind-filter").textContent).toBe(
    "11 of 16 kinds",
  );
  fireEvent.change(search, { target: { value: "pvc" } });
  expect(screen.getByText("No kind matches.")).toBeTruthy();
  fireEvent.change(search, { target: { value: "" } });
  fireEvent.click(screen.getByTestId("map-kind-select-all"));
  expect(screen.getByTestId("map-kind-filter").textContent).toBe("All kinds");
});

test("one popover at a time, and Escape returns focus to its trigger", () => {
  render(<Harness />);
  fireEvent.click(screen.getByTestId("map-ns-filter"));
  const kinds = screen.getByTestId("map-kind-filter");
  fireEvent.pointerDown(kinds);
  fireEvent.click(kinds);
  expect(screen.queryByTestId("map-ns-popover")).toBeNull();
  expect(screen.getByTestId("map-kind-popover")).toBeTruthy();
  fireEvent.keyDown(screen.getByTestId("map-kind-search"), { key: "Escape" });
  expect(screen.queryByTestId("map-kind-popover")).toBeNull();
  expect(document.activeElement).toBe(kinds);
});

test("Clear filters shows while anything is hidden and empties both lists; the summary ends the row", () => {
  render(<Harness />);
  const row = screen.getByRole("group", { name: "Map filters" });
  expect(row.getAttribute("data-testid")).toBe("map-filters");
  expect(row.lastElementChild).toBe(screen.getByTestId("map-summary"));
  expect(screen.getByTestId("map-summary").textContent).toBe(
    "22 resources · 3 namespaces · 16 kinds",
  );
  expect(screen.getByTestId("map-summary").getAttribute("title")).toBe(
    "Every resource in the cluster",
  );
  expect(screen.queryByTestId("map-clear-filters")).toBeNull();
  fireEvent.click(screen.getByTestId("map-ns-filter"));
  fireEvent.click(box("map-ns-option-edge"));
  fireEvent.click(screen.getByTestId("map-kind-filter"));
  fireEvent.click(box("map-kind-option-Pod"));
  const clear = screen.getByTestId("map-clear-filters");
  expect(clear.textContent).toBe("Clear filters");
  expect(clear.getAttribute("class")?.split(" ")).toContain("ghost");
  fireEvent.click(clear);
  expect(screen.queryByTestId("map-clear-filters")).toBeNull();
  expect(screen.getByTestId("map-ns-filter").textContent).toBe(
    "All namespaces",
  );
  expect(screen.getByTestId("map-kind-filter").textContent).toBe("All kinds");
});

test("a saved kind that is not present is not listed and does not count as filtering", () => {
  render(<Harness kinds={["Widget"]} />);
  expect(screen.getByTestId("map-kind-filter").textContent).toBe("All kinds");
  expect(screen.queryByTestId("map-clear-filters")).toBeNull();
  fireEvent.click(screen.getByTestId("map-kind-filter"));
  expect(screen.queryByTestId("map-kind-option-Widget")).toBeNull();
});

test("without a summary the row keeps its dropdowns and draws no summary", () => {
  render(
    <MapFilters
      counts={[]}
      hiddenNamespaces={[]}
      onHiddenNamespacesChange={() => {}}
      groups={[]}
      hiddenKinds={[]}
      onHiddenKindsChange={() => {}}
      summary={null}
      summaryTitle=""
    />,
  );
  expect(screen.queryByTestId("map-summary")).toBeNull();
  expect(screen.getByTestId("map-ns-filter").textContent).toBe(
    "All namespaces",
  );
  expect(screen.getByTestId("map-kind-filter").textContent).toBe("All kinds");
});
