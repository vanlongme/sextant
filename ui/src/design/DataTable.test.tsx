import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { type Column, DataTable } from "./DataTable";

interface Row {
  id: string;
  name: string;
  age: number;
}
const rows: Row[] = [
  { id: "a", name: "bravo", age: 3 },
  { id: "b", name: "alpha", age: 9 },
  { id: "c", name: "charlie", age: 1 },
];
const columns: Column<Row>[] = [
  {
    id: "name",
    header: "Name",
    sortable: true,
    sortValue: (r) => r.name,
    render: (r) => r.name,
  },
  {
    id: "age",
    header: "Age",
    sortable: true,
    sortValue: (r) => r.age,
    render: (r) => String(r.age),
  },
  { id: "id", header: "Id", render: (r) => r.id },
];

function names(): string[] {
  return screen
    .getAllByTestId("row")
    .map((tr) => within(tr).getAllByRole("cell")[0]?.textContent ?? "");
}

function renderTable(
  extra: Partial<Parameters<typeof DataTable<Row>>[0]> = {},
) {
  return render(
    <DataTable rows={rows} columns={columns} rowKey={(r) => r.id} {...extra} />,
  );
}

test("renders all rows", () => {
  renderTable();
  expect(names()).toEqual(["bravo", "alpha", "charlie"]);
});

test("clicking a sortable header sorts ascending then descending", () => {
  renderTable();
  fireEvent.click(screen.getByRole("button", { name: /name/i }));
  expect(names()).toEqual(["alpha", "bravo", "charlie"]);
  fireEvent.click(screen.getByRole("button", { name: /name/i }));
  expect(names()).toEqual(["charlie", "bravo", "alpha"]);
});

test("sorts numerically using sortValue", () => {
  renderTable();
  fireEvent.click(screen.getByRole("button", { name: /age/i }));
  expect(names()).toEqual(["charlie", "bravo", "alpha"]);
});

test("onRowClick fires with the row", () => {
  const onRowClick = vi.fn();
  renderTable({ onRowClick });
  fireEvent.click(screen.getAllByTestId("row")[1] as HTMLElement);
  expect(onRowClick).toHaveBeenCalledWith(rows[1]);
});

test("renders the empty slot with no rows", () => {
  render(
    <DataTable
      rows={[]}
      columns={columns}
      rowKey={(r: Row) => r.id}
      empty={<p>Nothing here</p>}
    />,
  );
  expect(screen.getByText("Nothing here")).toBeTruthy();
});

test("a table can be named and a column aligned to the end", () => {
  render(
    <DataTable
      rows={rows}
      columns={[
        columns[0] as Column<Row>,
        { ...(columns[1] as Column<Row>), align: "end" },
      ]}
      rowKey={(r) => r.id}
      label="People"
    />,
  );
  const table = screen.getByRole("table", { name: "People" });
  const header = within(table).getByRole("columnheader", { name: /age/i });
  expect(getComputedStyle(header).textAlign).toBe("right");
  const [name, age] = within(table).getAllByRole("cell");
  expect(getComputedStyle(age as HTMLElement).textAlign).toBe("right");
  expect(getComputedStyle(name as HTMLElement).textAlign).not.toBe("right");
});
