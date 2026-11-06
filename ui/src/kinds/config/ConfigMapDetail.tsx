import { api } from "../../ipc/api";
import { Part } from "../detail/parts";
import { objectKey } from "../objects";
import type { DetailProps } from "../registry";
import styles from "./config.module.css";
import { DataControls, DataRow, ValueInput } from "./DataControls";
import { dataOf, useDataEdits } from "./dataEdits";

function ConfigMapPanel({ clusterId, object }: DetailProps) {
  const edits = useDataEdits({
    version: object.metadata.resourceVersion ?? "",
    data: dataOf(object.data),
    send: (version, changes) =>
      api.configmapUpdate(
        clusterId,
        object.metadata.namespace ?? "",
        object.metadata.name,
        version,
        changes,
      ),
  });
  const binaryKeys = Object.keys(dataOf(object.binaryData)).sort();
  return (
    <Part title="Data">
      {edits.keys.length === 0 && binaryKeys.length === 0 ? (
        <p className={styles.muted}>No data.</p>
      ) : null}
      <ul className={styles.rows}>
        {edits.keys.map((key) => (
          <DataRow key={key} name={key} edits={edits}>
            <ValueInput
              label={`Value of ${key}`}
              testId={`configmap-input-${key}`}
              value={edits.textOf(key)}
              readOnly={edits.saving}
              onChange={(text) => edits.setText(key, text)}
            />
          </DataRow>
        ))}
        {binaryKeys.map((key) => (
          <li
            key={key}
            className={styles.head}
            data-testid={`data-binary-${key}`}
          >
            <code className={styles.key}>{key}</code>
            <span className={styles.muted}>binary, read-only</span>
          </li>
        ))}
      </ul>
      <DataControls edits={edits} reservedKeys={binaryKeys} />
    </Part>
  );
}

/** Remounts per object, which drops everything held in state. */
export function ConfigMapDetail(props: DetailProps) {
  return <ConfigMapPanel key={objectKey(props.object)} {...props} />;
}
