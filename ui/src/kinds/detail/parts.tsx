import type { ReactNode } from "react";
import { Link } from "react-router";
import { ownerTarget } from "../../features/details/ownerLinks";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import styles from "./parts.module.css";

/** Label and value pairs; an item whose value is empty is left out. */
export function Facts(props: {
  items: [string, ReactNode | undefined | null][];
}) {
  const shown = props.items.filter(
    ([, value]) => value !== undefined && value !== null && value !== "",
  );
  if (shown.length === 0) return null;
  return (
    <dl className={styles.facts}>
      {shown.map(([label, value]) => (
        <div key={label} className={styles.fact}>
          <dt className={styles.key}>{label}</dt>
          <dd className={styles.value}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A titled section of a kind's detail panel. */
export function Part(props: {
  title: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <section className={styles.section} data-testid={props.testId}>
      <h4 className={styles.heading}>{props.title}</h4>
      {props.children}
    </section>
  );
}

export function Chips(props: { values: string[] }) {
  return (
    <ul className={styles.chips}>
      {props.values.map((value, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: values may repeat
        <li key={`${index}:${value}`} className={styles.chip}>
          {value}
        </li>
      ))}
    </ul>
  );
}

export function SimpleTable(props: {
  testId?: string;
  headers: string[];
  rows: ReactNode[][];
  empty: string;
}) {
  if (props.rows.length === 0) {
    return <p className={styles.muted}>{props.empty}</p>;
  }
  return (
    <table className={styles.table} data-testid={props.testId}>
      <thead>
        <tr>
          {props.headers.map((header) => (
            <th key={header}>{header}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {props.rows.map((row, r) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity
          <tr key={r}>
            {row.map((cell, c) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: cells have no identity
              <td key={c}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** `<kind> <name>`, linked to the object's list when the kind is served. */
export function ObjectLink(props: {
  clusterId: string;
  resources: ApiResourceInfo[];
  kind: string;
  name: string;
  namespace?: string;
  apiVersion?: string;
}) {
  const target = ownerTarget(
    { kind: props.kind, name: props.name, apiVersion: props.apiVersion },
    props.namespace,
    props.resources,
  );
  const label = `${props.kind} ${props.name}`;
  if (!target) return <>{label}</>;
  return (
    <Link
      className={styles.link}
      to={`/cluster/${encodeURIComponent(props.clusterId)}${target}`}
    >
      {label}
    </Link>
  );
}
