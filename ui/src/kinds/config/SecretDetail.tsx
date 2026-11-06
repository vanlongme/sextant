import { useRef, useState } from "react";
import { Button, ErrorNotice } from "../../design";
import { api } from "../../ipc/api";
import { failureMessage } from "../../ipc/client";
import type { SecretValue } from "../../ipc/generated/SecretValue";
import { Part } from "../detail/parts";
import { objectKey } from "../objects";
import type { DetailProps } from "../registry";
import styles from "./config.module.css";
import { DataControls, DataRow, ValueInput } from "./DataControls";
import { dataOf, useDataEdits } from "./dataEdits";

const MASK = "••••••";

/** Revealed values live only here, in this component's state. */
interface RevealState {
  values: Map<string, SecretValue>;
  /** The request that may still fill in a key; any other answer is dropped. */
  pending: Map<string, number>;
  error: { key: string; message: string } | null;
}

const MASKED: RevealState = {
  values: new Map(),
  pending: new Map(),
  error: null,
};

function without<V>(map: Map<string, V>, key: string): Map<string, V> {
  const copy = new Map(map);
  copy.delete(key);
  return copy;
}

function blankValues(data: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.keys(data).map((key) => [key, ""]));
}

function SecretPanel({ clusterId, object }: DetailProps) {
  const namespace = object.metadata.namespace ?? "";
  const name = object.metadata.name;
  const [reveal, setReveal] = useState<RevealState>(MASKED);
  const lastRequest = useRef(0);
  const edits = useDataEdits({
    version: object.metadata.resourceVersion ?? "",
    data: blankValues(dataOf(object.data)),
    revealed: Object.fromEntries(
      [...reveal.values].map(([key, secretValue]) => [key, secretValue.value]),
    ),
    send: (version, changes) =>
      api.secretUpdate(clusterId, namespace, name, version, changes),
    afterSave: blankValues,
  });

  // A new baseline means a save, a reload or a change on the server, after
  // which what was revealed may be stale.
  const [maskedAt, setMaskedAt] = useState(edits.baseline);
  if (maskedAt !== edits.baseline) {
    setMaskedAt(edits.baseline);
    setReveal((r) => ({ ...MASKED, error: r.error }));
  }

  const hide = (key: string) => {
    edits.dropText(key);
    setReveal((r) => ({
      ...r,
      values: without(r.values, key),
      pending: without(r.pending, key),
    }));
  };

  const startReveal = (key: string) => {
    lastRequest.current += 1;
    const request = lastRequest.current;
    setReveal((r) => ({
      ...r,
      pending: new Map(r.pending).set(key, request),
      error: null,
    }));
    const settle = (change: (r: RevealState) => Partial<RevealState>) =>
      setReveal((r) =>
        r.pending.get(key) === request
          ? { ...r, pending: without(r.pending, key), ...change(r) }
          : r,
      );
    api.secretReveal(clusterId, namespace, name, key).then(
      (value) => settle((r) => ({ values: new Map(r.values).set(key, value) })),
      (error) =>
        settle(() => ({ error: { key, message: failureMessage(error) } })),
    );
  };

  return (
    <Part title="Data">
      {edits.keys.length === 0 ? (
        <p className={styles.muted}>No data.</p>
      ) : null}
      {reveal.error ? (
        <ErrorNotice
          title={`Could not reveal ${reveal.error.key}`}
          message={reveal.error.message}
        />
      ) : null}
      <ul className={styles.rows}>
        {edits.keys.map((key) => {
          const value = reveal.values.get(key);
          const editing = edits.hasText(key);
          const open = value !== undefined || reveal.pending.has(key);
          return (
            <DataRow
              key={key}
              name={key}
              edits={edits}
              actions={
                <>
                  {edits.inBaseline(key) ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={edits.saving}
                      data-testid={`secret-reveal-${key}`}
                      onClick={() => (open ? hide(key) : startReveal(key))}
                    >
                      {open ? `Hide ${key}` : `Reveal ${key}`}
                    </Button>
                  ) : null}
                  {value && !value.binary && !editing ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={edits.saving}
                      data-testid={`secret-edit-${key}`}
                      onClick={() => edits.setText(key, value.value)}
                    >
                      {`Edit ${key}`}
                    </Button>
                  ) : null}
                </>
              }
            >
              {editing ? (
                <ValueInput
                  label={`Value of ${key}`}
                  testId={`secret-input-${key}`}
                  value={edits.textOf(key)}
                  readOnly={edits.saving}
                  onChange={(text) => edits.setText(key, text)}
                />
              ) : (
                <div
                  className={styles.value}
                  data-testid={`secret-value-${key}`}
                >
                  {value ? value.value : MASK}
                </div>
              )}
              {value?.binary ? (
                <p className={styles.muted}>
                  Binary value, shown as base64. It cannot be edited here.
                </p>
              ) : null}
            </DataRow>
          );
        })}
      </ul>
      <DataControls edits={edits} />
    </Part>
  );
}

/** Remounts per object, which drops every revealed value. */
export function SecretDetail(props: DetailProps) {
  return <SecretPanel key={objectKey(props.object)} {...props} />;
}
