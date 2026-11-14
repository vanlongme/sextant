import { Tags } from "lucide-react";
import { useState } from "react";
import { CopyButton } from "../../design";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import {
  ExpandRow,
  FactList,
  FactRow,
  ObjectLink,
  Part,
} from "../../kinds/detail/parts";
import { formatCreated, type KubeObject } from "../../kinds/objects";
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

function None(props: { label: string; testId: string }) {
  return (
    <FactList>
      <FactRow label={props.label} testId={props.testId}>
        <span className={styles.muted}>None</span>
      </FactRow>
    </FactList>
  );
}

function Labels(props: { labels?: Record<string, string> }) {
  const entries = Object.entries(props.labels ?? {});
  if (entries.length === 0)
    return <None label="Labels" testId="detail-labels" />;
  return (
    <ExpandRow
      label="Labels"
      count={entries.length}
      summary={entries.map(([k, v]) => `${k}=${v}`).join(", ")}
      testId="detail-labels"
    >
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
    </ExpandRow>
  );
}

function Annotations(props: { annotations?: Record<string, string> }) {
  const entries = Object.entries(props.annotations ?? {});
  if (entries.length === 0) {
    return <None label="Annotations" testId="detail-annotations" />;
  }
  return (
    <ExpandRow
      label="Annotations"
      count={entries.length}
      summary={entries.map(([k]) => k).join(", ")}
      testId="detail-annotations"
    >
      <dl className={styles.pairs}>
        {entries.map(([k, v]) => (
          <Annotation key={k} name={k} value={v} />
        ))}
      </dl>
    </ExpandRow>
  );
}

/** Identity, labels and annotations of an object, each row with a copy button (spec H31). */
export function MetadataSection(props: {
  object: KubeObject;
  clusterId: string;
  resources: ApiResourceInfo[];
}) {
  const { metadata } = props.object;
  const created = metadata.creationTimestamp;
  const plain: [string, string | undefined][] = [
    ["UID", metadata.uid],
    ["Resource version", metadata.resourceVersion],
    ["Deleting since", metadata.deletionTimestamp],
  ];
  return (
    <Part title="Metadata" icon={Tags} testId="detail-metadata">
      <dl className={styles.facts}>
        <CopyRow label="Name">{metadata.name}</CopyRow>
        {metadata.namespace ? (
          <CopyRow label="Namespace" copy={metadata.namespace}>
            <ObjectLink
              clusterId={props.clusterId}
              resources={props.resources}
              kind="Namespace"
              name={metadata.namespace}
              apiVersion="v1"
              label={metadata.namespace}
            />
          </CopyRow>
        ) : null}
        {created ? (
          <CopyRow label="Created" copy={created}>
            {formatCreated(created)}
          </CopyRow>
        ) : null}
        {plain
          .filter(([, v]) => v !== undefined && v !== "")
          .map(([k, v]) => (
            <CopyRow key={k} label={k}>
              {v}
            </CopyRow>
          ))}
      </dl>
      <Labels labels={metadata.labels} />
      <Annotations annotations={metadata.annotations} />
    </Part>
  );
}
