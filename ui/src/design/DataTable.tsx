import { type ReactNode, useMemo, useState } from "react";
import styles from "./DataTable.module.css";

export interface Column<T> {
  id: string;
  header: string;
  width?: string;
  /** "end" right-aligns the header and the cells, as for numbers. */
  align?: "start" | "end";
  sortable?: boolean;
  sortValue?(row: T): string | number;
  render(row: T): ReactNode;
}

type Sort = { id: string; dir: "asc" | "desc" };

/** Shared: `localeCompare` with options builds one of these on every call. */
const collator = new Intl.Collator(undefined, { numeric: true });

export function compare(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return collator.compare(String(a), String(b));
}

function alignClass<T>(column: Column<T>): string | undefined {
  return column.align === "end" ? styles.end : undefined;
}

export function DataTable<T>(props: {
  rows: T[];
  columns: Column<T>[];
  rowKey(row: T): string;
  rowTestId?(row: T): string;
  onRowClick?(row: T): void;
  empty?: ReactNode;
  /** The table's accessible name. */
  label?: string;
  testId?: string;
}) {
  const [sort, setSort] = useState<Sort | null>(null);

  const rows = useMemo(() => {
    const col = sort ? props.columns.find((c) => c.id === sort.id) : undefined;
    const value = col?.sortValue;
    if (!sort || !value) return props.rows;
    const sign = sort.dir === "asc" ? 1 : -1;
    return [...props.rows].sort((a, b) => sign * compare(value(a), value(b)));
  }, [props.rows, props.columns, sort]);

  function toggle(id: string): void {
    setSort((s) =>
      s?.id === id && s.dir === "asc"
        ? { id, dir: "desc" }
        : { id, dir: "asc" },
    );
  }

  if (props.rows.length === 0 && props.empty) {
    return <div data-testid={props.testId}>{props.empty}</div>;
  }

  return (
    <table
      className={styles.table}
      aria-label={props.label}
      data-testid={props.testId}
    >
      <thead>
        <tr>
          {props.columns.map((c) => {
            const active = sort?.id === c.id ? sort : null;
            return (
              <th
                key={c.id}
                className={alignClass(c)}
                style={c.width ? { width: c.width } : undefined}
                aria-sort={
                  active
                    ? active.dir === "asc"
                      ? "ascending"
                      : "descending"
                    : undefined
                }
              >
                {c.sortable ? (
                  <button
                    type="button"
                    className={styles.sort}
                    onClick={() => toggle(c.id)}
                  >
                    {c.header}
                    <span aria-hidden="true">
                      {active ? (active.dir === "asc" ? " ▲" : " ▼") : ""}
                    </span>
                  </button>
                ) : (
                  c.header
                )}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={props.rowKey(row)}
            data-testid={props.rowTestId?.(row) ?? "row"}
            className={props.onRowClick ? styles.clickable : undefined}
            onClick={
              props.onRowClick ? () => props.onRowClick?.(row) : undefined
            }
          >
            {props.columns.map((c) => (
              <td key={c.id} className={alignClass(c)}>
                {c.render(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
