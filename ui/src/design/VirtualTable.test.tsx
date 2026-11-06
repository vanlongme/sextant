import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mockElementSize } from "../test/size";
import { type TableColumn, useNow, VirtualTable } from "./VirtualTable";

interface Row {
  id: string;
  name: string;
  size: number;
}

const columns: TableColumn<Row>[] = [
  {
    id: "name",
    header: "Name",
    width: "1fr",
    sortValue: (r) => r.name,
    render: (r) => r.name,
  },
  {
    id: "size",
    header: "Size",
    width: 80,
    sortValue: (r) => r.size,
    render: (r) => r.size,
  },
  { id: "note", header: "Note", width: 80, render: () => "a note" },
];

const row = (id: string, name = id, size = 0): Row => ({ id, name, size });
const rowKey = (r: Row) => r.id;
const rowTestId = (r: Row) => `row-${r.id}`;

/** The ids of the rendered rows, top to bottom. */
function shownIds(): string[] {
  return screen
    .getAllByTestId(/^row-/)
    .map((el) => (el.dataset.testid ?? "").replace("row-", ""));
}

function checkbox(name: string): HTMLInputElement {
  return screen.getByRole("checkbox", { name }) as HTMLInputElement;
}

beforeEach(() => mockElementSize());
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("renders only a window of 10000 rows", () => {
  const rows = Array.from({ length: 10000 }, (_, i) => row(`r${i}`));
  render(
    <VirtualTable
      rows={rows}
      columns={columns}
      rowKey={rowKey}
      rowTestId={rowTestId}
      testId="table"
    />,
  );
  const shown = screen.getAllByTestId(/^row-/);
  expect(shown.length).toBeGreaterThan(0);
  expect(shown.length).toBeLessThan(200);
  expect(screen.getByTestId("table").getAttribute("aria-rowcount")).toBe(
    "10001",
  );
});

test("clicking a sortable header cycles asc, desc, none", () => {
  const rows = [row("b"), row("c"), row("a")];
  render(
    <VirtualTable
      rows={rows}
      columns={columns}
      rowKey={rowKey}
      rowTestId={rowTestId}
    />,
  );
  const header = screen.getByRole("columnheader", { name: /Name/ });
  const button = screen.getByRole("button", { name: /Name/ });

  fireEvent.click(button);
  expect(shownIds()).toEqual(["a", "b", "c"]);
  expect(header.getAttribute("aria-sort")).toBe("ascending");

  fireEvent.click(button);
  expect(shownIds()).toEqual(["c", "b", "a"]);
  expect(header.getAttribute("aria-sort")).toBe("descending");

  fireEvent.click(button);
  expect(shownIds()).toEqual(["b", "c", "a"]);
  expect(header.getAttribute("aria-sort")).toBeNull();

  // A column without a sort value has no sort control.
  expect(screen.queryByRole("button", { name: /Note/ })).toBeNull();
});

test("a controlled sort reports changes and shows what it is given", () => {
  const onSortChange = vi.fn();
  render(
    <VirtualTable
      rows={[row("a"), row("b")]}
      columns={columns}
      rowKey={rowKey}
      rowTestId={rowTestId}
      sort={{ id: "name", dir: "desc" }}
      onSortChange={onSortChange}
    />,
  );
  expect(shownIds()).toEqual(["b", "a"]);
  fireEvent.click(screen.getByRole("button", { name: /Name/ }));
  expect(onSortChange).toHaveBeenCalledWith(null);
  expect(shownIds()).toEqual(["b", "a"]);
});

test("sorts numbers numerically and strings with locale compare", () => {
  const rows = [row("r1", "b", 10), row("r2", "C", 9), row("r3", "a", 100)];
  render(
    <VirtualTable
      rows={rows}
      columns={columns}
      rowKey={rowKey}
      rowTestId={rowTestId}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /Size/ }));
  // As strings these would be 10, 100, 9.
  expect(shownIds()).toEqual(["r2", "r1", "r3"]);
  fireEvent.click(screen.getByRole("button", { name: /Name/ }));
  // By code unit, "C" would come first.
  expect(shownIds()).toEqual(["r3", "r1", "r2"]);
});

test("sorting 10000 rows reads each sort value once and shares one collator", () => {
  const rows = Array.from({ length: 10000 }, (_, i) =>
    row(`r${i}`, `pod-${(i * 7919) % 10000}`),
  );
  const sortValue = vi.fn((r: Row) => r.name);
  // Building a collator per comparison is what makes a sort this size take a second.
  const perCall = vi.spyOn(String.prototype, "localeCompare");
  render(
    <VirtualTable
      rows={rows}
      columns={[{ ...columns[0], sortValue }]}
      rowKey={rowKey}
      rowTestId={rowTestId}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /Name/ }));

  expect(sortValue).toHaveBeenCalledTimes(10000);
  expect(perCall).not.toHaveBeenCalled();
  // Numeric, so pod-2 comes before pod-10.
  const names = screen
    .getAllByTestId(/^row-/)
    .slice(0, 3)
    .map((el) => el.textContent);
  expect(names).toEqual(["pod-0", "pod-1", "pod-2"]);
});

test("hidden columns are not rendered", () => {
  const withHidden: TableColumn<Row>[] = [
    ...columns,
    { id: "extra", header: "Extra", width: 80, render: () => "an extra" },
    {
      id: "wide",
      header: "Wide",
      width: 80,
      defaultHidden: true,
      render: () => "wide value",
    },
  ];
  const { rerender } = render(
    <VirtualTable
      rows={[row("a")]}
      columns={withHidden}
      rowKey={rowKey}
      hiddenColumns={["note"]}
    />,
  );
  expect(screen.queryByText("Note")).toBeNull();
  expect(screen.queryByText("a note")).toBeNull();
  expect(screen.getByText("an extra")).toBeTruthy();
  // The caller's list decides, so a column hidden by default can be shown.
  expect(screen.getByText("wide value")).toBeTruthy();

  rerender(
    <VirtualTable rows={[row("a")]} columns={withHidden} rowKey={rowKey} />,
  );
  expect(screen.getByText("a note")).toBeTruthy();
  expect(screen.queryByText("wide value")).toBeNull();
});

function Selectable(props: {
  rows: Row[];
  initial?: string[];
  onRowClick?(r: Row): void;
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    new Set(props.initial),
  );
  return (
    <>
      <VirtualTable
        rows={props.rows}
        columns={columns}
        rowKey={rowKey}
        rowTestId={rowTestId}
        selected={selected}
        onSelectedChange={setSelected}
        onRowClick={props.onRowClick}
      />
      <output data-testid="selected">{[...selected].sort().join(",")}</output>
    </>
  );
}

const selectedText = () => screen.getByTestId("selected").textContent;

test("selection supports header select-all over filtered rows and shift range", () => {
  const all = ["a", "b", "c", "d", "e"].map((id) => row(id));
  const { rerender } = render(<Selectable rows={all} />);

  // A range runs through the rows in between, in either direction.
  fireEvent.click(checkbox("Select b"));
  fireEvent.click(checkbox("Select d"), { shiftKey: true });
  expect(selectedText()).toBe("b,c,d");
  expect(checkbox("Select all rows").indeterminate).toBe(true);

  // A range takes the new state of the row that was clicked.
  fireEvent.click(checkbox("Select d"), { shiftKey: true });
  expect(selectedText()).toBe("b,c");

  // With a filter, select-all takes the shown rows and keeps the others as they were.
  rerender(<Selectable rows={[all[3], all[4]]} />);
  expect(checkbox("Select all rows").checked).toBe(false);
  fireEvent.click(checkbox("Select all rows"));
  expect(selectedText()).toBe("b,c,d,e");
  expect(checkbox("Select all rows").checked).toBe(true);
  fireEvent.click(checkbox("Select all rows"));
  expect(selectedText()).toBe("b,c");
});

test("rows expose aria-selected and keyboard Enter activates the row", () => {
  const onRowClick = vi.fn();
  render(
    <Selectable
      rows={[row("a"), row("b")]}
      initial={["b"]}
      onRowClick={onRowClick}
    />,
  );
  const a = screen.getByTestId("row-a");
  expect(a.getAttribute("aria-selected")).toBe("false");
  expect(screen.getByTestId("row-b").getAttribute("aria-selected")).toBe(
    "true",
  );

  fireEvent.keyDown(a, { key: "Enter" });
  expect(onRowClick).toHaveBeenCalledTimes(1);
  expect(onRowClick).toHaveBeenLastCalledWith(row("a"));
  fireEvent.keyDown(a, { key: "x" });
  expect(onRowClick).toHaveBeenCalledTimes(1);

  // Controls inside the row keep their own click and keyboard behaviour.
  fireEvent.keyDown(checkbox("Select a"), { key: "Enter" });
  fireEvent.click(checkbox("Select a"));
  expect(onRowClick).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByText("a"));
  expect(onRowClick).toHaveBeenCalledTimes(2);
});

test("the active row is marked and only clickable rows take focus", () => {
  const { rerender } = render(
    <VirtualTable
      rows={[row("a"), row("b")]}
      columns={columns}
      rowKey={rowKey}
      rowTestId={rowTestId}
      activeKey="b"
    />,
  );
  expect(screen.getByTestId("row-b").getAttribute("aria-current")).toBe("true");
  expect(screen.getByTestId("row-a").getAttribute("aria-current")).toBeNull();
  expect(screen.getByTestId("row-a").getAttribute("tabindex")).toBeNull();
  rerender(
    <VirtualTable
      rows={[row("a"), row("b")]}
      columns={columns}
      rowKey={rowKey}
      rowTestId={rowTestId}
      onRowClick={() => {}}
    />,
  );
  expect(screen.getByTestId("row-a").getAttribute("tabindex")).toBe("0");
});

function Clock() {
  return <span data-testid="clock">{useNow()}</span>;
}

test("every clock reading comes from one shared 30 s timer", () => {
  vi.useFakeTimers();
  const interval = vi.spyOn(globalThis, "setInterval");
  const { unmount } = render(
    <>
      <Clock />
      <Clock />
      <Clock />
    </>,
  );
  const timers = interval.mock.calls.filter((c) => c[1] === 30_000);
  expect(timers).toHaveLength(1);
  const before = Number(screen.getAllByTestId("clock")[2].textContent);
  act(() => {
    vi.advanceTimersByTime(30_000);
  });
  const readings = screen.getAllByTestId("clock").map((c) => c.textContent);
  expect(new Set(readings).size).toBe(1);
  expect(Number(readings[0])).toBe(before + 30_000);
  const clear = vi.spyOn(globalThis, "clearInterval");
  unmount();
  expect(clear).toHaveBeenCalledTimes(1);
});

test("a hidden column does not keep sorting the rows", () => {
  render(
    <VirtualTable
      rows={[row("a", "a", 2), row("b", "b", 1)]}
      columns={columns}
      rowKey={rowKey}
      rowTestId={rowTestId}
      hiddenColumns={["size"]}
      sort={{ id: "size", dir: "asc" }}
    />,
  );
  expect(shownIds()).toEqual(["a", "b"]);
});

test("the checkbox of a row reads its label", () => {
  render(
    <VirtualTable
      rows={[row("a")]}
      columns={columns}
      rowKey={rowKey}
      rowLabel={(r) => `row ${r.name}`}
      selected={new Set()}
      onSelectedChange={() => {}}
    />,
  );
  expect(checkbox("Select row a")).toBeTruthy();
});
