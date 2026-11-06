import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import styles from "./DetailDrawer.module.css";

/** Levels below the top that start expanded. */
const OPEN_DEPTH = 1;

function isContainer(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function entriesOf(value: object): [string, unknown][] {
  return Array.isArray(value)
    ? value.map((v, i) => [String(i), v])
    : Object.entries(value);
}

function scalar(value: unknown): string {
  if (value === null) return "null";
  return typeof value === "string" ? value : String(value);
}

function summary(value: object): string {
  const count = entriesOf(value).length;
  return Array.isArray(value) ? `[${count}]` : `{${count}}`;
}

function Node(props: { name: string; value: unknown; depth: number }) {
  const { name, value, depth } = props;
  const [open, setOpen] = useState(depth <= OPEN_DEPTH);
  if (!isContainer(value)) {
    return (
      <li className={styles.fieldRow}>
        <span className={styles.fieldName}>{name}</span>
        <span className={styles.fieldValue}>{scalar(value)}</span>
      </li>
    );
  }
  const children = entriesOf(value);
  return (
    <li>
      <button
        type="button"
        className={styles.fieldToggle}
        aria-expanded={open}
        aria-label={`${name} ${summary(value)}`}
        onClick={() => setOpen(!open)}
      >
        {open ? (
          <ChevronDown size={12} aria-hidden="true" />
        ) : (
          <ChevronRight size={12} aria-hidden="true" />
        )}
        <span className={styles.fieldName}>{name}</span>
        <span className={styles.fieldHint}>{summary(value)}</span>
      </button>
      {open && children.length > 0 ? (
        <ul className={styles.fieldList}>
          {children.map(([k, v]) => (
            <Node key={k} name={k} value={v} depth={depth + 1} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** Any JSON value as an expandable tree. Structures nested deeply start collapsed. */
export function FieldTree(props: { value: unknown }) {
  const { value } = props;
  return (
    <div data-testid="detail-fields">
      {isContainer(value) ? (
        entriesOf(value).length === 0 ? (
          <span className={styles.fieldHint}>Empty</span>
        ) : (
          <ul className={styles.fieldList}>
            {entriesOf(value).map(([k, v]) => (
              <Node key={k} name={k} value={v} depth={0} />
            ))}
          </ul>
        )
      ) : (
        <span className={styles.fieldValue}>{scalar(value)}</span>
      )}
    </div>
  );
}
