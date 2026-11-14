import { type ReactNode, useContext } from "react";
import { Link } from "react-router";
import { ownerTarget } from "../../features/details/ownerLinks";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import { DrawerLinkContext, objectTarget, targetKey } from "./links";
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

/**
 * `<kind> <name>`, or `label`. Inside a drawer it is a button that opens the object in
 * that drawer; elsewhere a link to the object's list. Plain text when the kind is not
 * served.
 */
export function ObjectLink(props: {
  clusterId: string;
  resources: ApiResourceInfo[];
  kind: string;
  name: string;
  namespace?: string;
  apiVersion?: string;
  label?: string;
  testId?: string;
}) {
  const drawer = useContext(DrawerLinkContext);
  const ref = {
    kind: props.kind,
    name: props.name,
    apiVersion: props.apiVersion,
  };
  const label = props.label ?? `${props.kind} ${props.name}`;
  if (drawer) {
    const target = objectTarget(ref, props.namespace, props.resources);
    if (!target) return <>{label}</>;
    return (
      <button
        type="button"
        className={styles.link}
        data-testid={props.testId ?? "detail-link"}
        data-target={targetKey(target)}
        title={`Open ${props.kind} ${props.name}`}
        onClick={() => drawer.open(target)}
      >
        {label}
      </button>
    );
  }
  const route = ownerTarget(ref, props.namespace, props.resources);
  if (!route) return <>{label}</>;
  return (
    <Link
      className={styles.link}
      to={`/cluster/${encodeURIComponent(props.clusterId)}${route}`}
      data-testid={props.testId}
    >
      {label}
    </Link>
  );
}
