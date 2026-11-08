import { useState } from "react";
import { CopyButton } from "../../design";
import type { KubeObject } from "../../kinds/objects";
import { CopyRow } from "./CopyRow";
import styles from "./DetailDrawer.module.css";

/** Values longer than this, or with several lines, start collapsed. */
const LONG = 120;

function Annotation(props: { name: string; value: string }) {
  const { name, value } = props;
  const long = value.length > LONG || value.includes("\n");
  const [open, setOpen] = useState(false);
  return (
    <div className={`${styles.copyHost} ${styles.annotation}`}>
      <dt className={styles.annotationKey}>
        <span className={styles.key}>{name}</span>
        {/* The whole value, even while it is shown collapsed. */}
        <CopyButton
          className={styles.copy}
          what={`annotation ${name}`}
          value={() => value}
        />
      </dt>
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

function Labels(props: { labels?: Record<string, string> }) {
  const entries = Object.entries(props.labels ?? {});
  return (
    <section className={styles.section} data-testid="detail-labels">
      <h4 className={styles.heading}>Labels</h4>
      {entries.length === 0 ? (
        <p className={styles.muted}>None</p>
      ) : (
        <ul className={styles.labelRows}>
          {entries.map(([k, v]) => (
            <li key={k} className={`${styles.copyHost} ${styles.labelRow}`}>
              <span className={styles.labelText}>
                {k}={v}
              </span>
              <CopyButton
                className={styles.copy}
                what={`label ${k}`}
                value={() => `${k}=${v}`}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Annotations(props: { annotations?: Record<string, string> }) {
  const entries = Object.entries(props.annotations ?? {});
  return (
    <section className={styles.section} data-testid="detail-annotations">
      <h4 className={styles.heading}>Annotations</h4>
      {entries.length === 0 ? (
        <p className={styles.muted}>None</p>
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

/** Identity, labels and annotations of an object, each row with a copy button. */
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
              <CopyRow key={k} label={k}>
                {v}
              </CopyRow>
            ))}
        </dl>
      </section>
      <Labels labels={metadata.labels} />
      <Annotations annotations={metadata.annotations} />
    </>
  );
}
