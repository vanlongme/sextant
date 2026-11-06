import { useState } from "react";
import type { KubeObject } from "../../kinds/objects";
import styles from "./DetailDrawer.module.css";

/** Values longer than this, or with several lines, start collapsed. */
const LONG = 120;

function Annotation(props: { name: string; value: string }) {
  const { name, value } = props;
  const long = value.length > LONG || value.includes("\n");
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.annotation}>
      <dt className={styles.key}>{name}</dt>
      <dd
        className={open || !long ? styles.valueFull : styles.valueClamped}
        data-testid="annotation-value"
      >
        {value}
      </dd>
      {long ? (
        <button
          type="button"
          className={styles.link}
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} annotation ${name}`}
          onClick={() => setOpen(!open)}
        >
          {open ? "Collapse" : "Expand"}
        </button>
      ) : null}
    </div>
  );
}

function Pairs(props: {
  title: string;
  testId: string;
  pairs?: Record<string, string>;
}) {
  const entries = Object.entries(props.pairs ?? {});
  return (
    <section className={styles.section} data-testid={props.testId}>
      <h4 className={styles.heading}>{props.title}</h4>
      {entries.length === 0 ? (
        <p className={styles.muted}>None</p>
      ) : props.testId === "detail-labels" ? (
        <ul className={styles.chips}>
          {entries.map(([k, v]) => (
            <li key={k} className={styles.chip}>
              {k}={v}
            </li>
          ))}
        </ul>
      ) : (
        <dl className={styles.pairs}>
          {entries.map(([k, v]) => (
            <Annotation key={k} name={k} value={v} />
          ))}
        </dl>
      )}
    </section>
  );
}

/** Identity, labels and annotations of an object. */
export function MetadataSection(props: { object: KubeObject }) {
  const { metadata } = props.object;
  const facts: [string, string | undefined][] = [
    ["Name", metadata.name],
    ["Namespace", metadata.namespace],
    ["Created", metadata.creationTimestamp],
    ["UID", metadata.uid],
    ["Resource version", metadata.resourceVersion],
    ["Deleting since", metadata.deletionTimestamp],
  ];
  return (
    <>
      <section className={styles.section}>
        <h4 className={styles.heading}>Metadata</h4>
        <dl className={styles.facts}>
          {facts
            .filter(([, v]) => v !== undefined && v !== "")
            .map(([k, v]) => (
              <div key={k} className={styles.fact}>
                <dt className={styles.key}>{k}</dt>
                <dd className={styles.value}>{v}</dd>
              </div>
            ))}
        </dl>
      </section>
      <Pairs title="Labels" testId="detail-labels" pairs={metadata.labels} />
      <Pairs
        title="Annotations"
        testId="detail-annotations"
        pairs={metadata.annotations}
      />
    </>
  );
}
