import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { compare } from "./DataTable";
import styles from "./VirtualTable.module.css";

export interface TableColumn<T> {
  id: string;
  header: string;
  /** Pixels, or any CSS grid track such as `minmax(160px, 1fr)`. */
  width: number | string;
  /** A column can be sorted when it has this. */
  sortValue?(row: T): string | number;
  render(row: T): ReactNode;
  /** Hidden unless the table is given its own `hiddenColumns`. */
  defaultHidden?: boolean;
}

export type TableSort = { id: string; dir: "asc" | "desc" };

const DEFAULT_ROW_HEIGHT = 34;
const OVERSCAN = 10;
/** 12 px cell padding on each side of the 18 px checkbox, plus 2 px to spare. */
const SELECT_TRACK_PX = 44;
const CLOCK_TICK_MS = 30_000;

let clockNow = Date.now();
let clockTimer: ReturnType<typeof setInterval> | null = null;
const clockListeners = new Set<() => void>();

function subscribeClock(listener: () => void): () => void {
  if (clockListeners.size === 0) {
    clockNow = Date.now();
    clockTimer = setInterval(() => {
      clockNow = Date.now();
      for (const l of clockListeners) l();
    }, CLOCK_TICK_MS);
  }
  clockListeners.add(listener);
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size === 0 && clockTimer !== null) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}

/**
 * The current time, for cells that show an age. Every cell reads the same timer, so
 * 10,000 rows do not mean 10,000 timers, and ages move together.
 */
export function useNow(): number {
  return useSyncExternalStore(subscribeClock, () => clockNow);
}

function track(width: number | string): string {
  return typeof width === "number" ? `${width}px` : width;
}

/** The narrowest a track can be, so the table scrolls sideways rather than crushes. */
function trackMinimum(width: number | string): number {
  if (typeof width === "number") return width;
  const px = /^(?:minmax\()?(\d+)px/.exec(width);
  return px ? Number(px[1]) : 0;
}

/** True for a click or key press meant for a control inside the row, or a portal. */
function belongsToControl(event: MouseEvent | KeyboardEvent): boolean {
  const target = event.target as Element;
  return (
    !event.currentTarget.contains(target) ||
    target.closest("a, button, input, select, textarea") !== null
  );
}

export function VirtualTable<T>(props: {
  rows: T[];
  columns: TableColumn<T>[];
  rowKey(row: T): string;
  /** Replaces what `defaultHidden` would hide. */
  hiddenColumns?: string[];
  /** Leave out for a table that keeps its own sort. */
  sort?: TableSort | null;
  onSortChange?(s: TableSort | null): void;
  selected?: ReadonlySet<string>;
  /** Adds a column of checkboxes. */
  onSelectedChange?(s: Set<string>): void;
  onRowClick?(row: T): void;
  rowTestId?(row: T): string;
  /** What a row's checkbox is named after: `Select <label>`. Defaults to the row key. */
  rowLabel?(row: T): string;
  activeKey?: string;
  testId?: string;
  rowHeight?: number;
}): React.JSX.Element {
  const { rowKey, onRowClick, onSelectedChange } = props;
  const rowHeight = props.rowHeight ?? DEFAULT_ROW_HEIGHT;
  const selected = props.selected;

  const [ownSort, setOwnSort] = useState<TableSort | null>(null);
  const sort = props.sort !== undefined ? props.sort : ownSort;

  const columns = useMemo(() => {
    const hidden = props.hiddenColumns;
    return props.columns.filter((c) =>
      hidden ? !hidden.includes(c.id) : !c.defaultHidden,
    );
  }, [props.columns, props.hiddenColumns]);

  const rows = useMemo(() => {
    const value = columns.find((c) => c.id === sort?.id)?.sortValue;
    if (!sort || !value) return props.rows;
    const sign = sort.dir === "asc" ? 1 : -1;
    // Each row's value is read once: it may mean evaluating a JSONPath.
    return props.rows
      .map((row) => ({ row, key: value(row) }))
      .sort((a, b) => sign * compare(a.key, b.key))
      .map(({ row }) => row);
  }, [props.rows, columns, sort]);

  function changeSort(id: string): void {
    let next: TableSort | null = { id, dir: "asc" };
    if (sort?.id === id) {
      next = sort.dir === "asc" ? { id, dir: "desc" } : null;
    }
    setOwnSort(next);
    props.onSortChange?.(next);
  }

  const scroller = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => rowHeight,
    overscan: OVERSCAN,
  });

  /** The last row whose checkbox was used, where a shift range starts. */
  const anchor = useRef<string | null>(null);

  function toggleRow(row: T, index: number, shift: boolean): void {
    const key = rowKey(row);
    const on = !selected?.has(key);
    const next = new Set(selected);
    const from =
      shift && anchor.current !== null
        ? rows.findIndex((r) => rowKey(r) === anchor.current)
        : -1;
    const [first, last] =
      from === -1
        ? [index, index]
        : [Math.min(from, index), Math.max(from, index)];
    for (let i = first; i <= last; i++) {
      if (on) next.add(rowKey(rows[i]));
      else next.delete(rowKey(rows[i]));
    }
    anchor.current = key;
    onSelectedChange?.(next);
  }

  const selectedShown = selected
    ? rows.filter((r) => selected.has(rowKey(r))).length
    : 0;
  const allShownSelected = rows.length > 0 && selectedShown === rows.length;

  function toggleAll(): void {
    const next = new Set(selected);
    for (const row of rows) {
      if (allShownSelected) next.delete(rowKey(row));
      else next.add(rowKey(row));
    }
    onSelectedChange?.(next);
  }

  const selectable = onSelectedChange !== undefined;
  const tracks = columns.map((c) => track(c.width));
  const minWidth = columns.reduce(
    (sum, c) => sum + trackMinimum(c.width),
    selectable ? SELECT_TRACK_PX : 0,
  );
  const layout = {
    "--vt-columns": [
      ...(selectable ? [`${SELECT_TRACK_PX}px`] : []),
      ...tracks,
    ].join(" "),
    "--vt-min-width": `${minWidth}px`,
  } as CSSProperties;

  return (
    <div ref={scroller} className={styles.scroller} style={layout}>
      <table
        className={styles.table}
        // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: rows are selected and activated, which is what a grid is, and aria-selected needs one.
        role="grid"
        aria-rowcount={rows.length + 1}
        data-testid={props.testId}
      >
        <thead className={styles.head}>
          <tr className={styles.row} style={{ height: rowHeight }}>
            {selectable ? (
              <th className={styles.cell}>
                <input
                  type="checkbox"
                  aria-label="Select all rows"
                  checked={allShownSelected}
                  ref={(el) => {
                    if (el) {
                      el.indeterminate = selectedShown > 0 && !allShownSelected;
                    }
                  }}
                  onChange={toggleAll}
                />
              </th>
            ) : null}
            {columns.map((c) => {
              const active = sort?.id === c.id ? sort : null;
              return (
                <th
                  key={c.id}
                  className={styles.cell}
                  aria-sort={
                    active
                      ? active.dir === "asc"
                        ? "ascending"
                        : "descending"
                      : undefined
                  }
                >
                  {c.sortValue ? (
                    <button
                      type="button"
                      className={styles.sort}
                      onClick={() => changeSort(c.id)}
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
        <tbody
          className={styles.body}
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            const key = rowKey(row);
            const isSelected = selected?.has(key) ?? false;
            return (
              <tr
                key={key}
                className={[
                  styles.row,
                  styles.bodyRow,
                  onRowClick ? styles.clickable : "",
                  isSelected ? styles.selected : "",
                  key === props.activeKey ? styles.active : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                style={{
                  height: rowHeight,
                  transform: `translateY(${item.start}px)`,
                }}
                aria-rowindex={item.index + 2}
                aria-selected={isSelected}
                aria-current={key === props.activeKey ? "true" : undefined}
                data-testid={props.rowTestId?.(row)}
                tabIndex={onRowClick ? 0 : undefined}
                onClick={
                  onRowClick
                    ? (e) => {
                        if (!belongsToControl(e)) onRowClick(row);
                      }
                    : undefined
                }
                onKeyDown={
                  onRowClick
                    ? (e) => {
                        if (e.key === "Enter" && e.target === e.currentTarget) {
                          onRowClick(row);
                        }
                      }
                    : undefined
                }
              >
                {selectable ? (
                  <td className={styles.cell}>
                    <input
                      type="checkbox"
                      aria-label={`Select ${props.rowLabel?.(row) ?? key}`}
                      checked={isSelected}
                      onChange={(e) =>
                        toggleRow(
                          row,
                          item.index,
                          (e.nativeEvent as globalThis.MouseEvent).shiftKey,
                        )
                      }
                    />
                  </td>
                ) : null}
                {columns.map((c) => (
                  <td key={c.id} className={styles.cell}>
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
