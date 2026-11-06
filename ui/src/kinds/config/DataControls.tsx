import { type ReactNode, useState } from "react";
import { Button, ErrorNotice, Input } from "../../design";
import styles from "./config.module.css";
import { type DataEditState, isValidDataKey } from "./dataEdits";

const INVALID_KEY = "A key may hold only letters, digits, `.`, `-` and `_`.";
const MAX_ROWS = 12;

/** A key's text box, as tall as its text up to a limit. */
export function ValueInput(props: {
  label: string;
  testId: string;
  value: string;
  readOnly?: boolean;
  onChange(value: string): void;
}) {
  return (
    <textarea
      className={styles.input}
      aria-label={props.label}
      data-testid={props.testId}
      rows={Math.min(props.value.split("\n").length + 1, MAX_ROWS)}
      spellCheck={false}
      readOnly={props.readOnly}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
    />
  );
}

/** One key: its name, its actions and Remove, then its value unless removed. */
export function DataRow(props: {
  name: string;
  edits: DataEditState;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const { name, edits } = props;
  const removed = edits.isRemoved(name);
  return (
    <li className={styles.row}>
      <div className={styles.head}>
        <code className={removed ? styles.removedKey : styles.key}>{name}</code>
        <span className={styles.actions}>
          {removed ? null : props.actions}
          <Button
            size="sm"
            variant="ghost"
            disabled={edits.saving}
            data-testid={`data-remove-${name}`}
            onClick={() =>
              removed ? edits.undoRemove(name) : edits.remove(name)
            }
          >
            {removed ? `Undo remove ${name}` : `Remove ${name}`}
          </Button>
        </span>
      </div>
      {removed ? null : props.children}
    </li>
  );
}

function ServerNotices({ edits }: { edits: DataEditState }) {
  const reload = (
    <Button
      size="sm"
      disabled={edits.saving}
      data-testid="data-reload"
      onClick={edits.reload}
    >
      Reload
    </Button>
  );
  if (edits.conflict) {
    return (
      <div className={styles.notice} role="alert" data-testid="data-conflict">
        <span>
          This object changed on the server, so it was not saved. Your text is
          kept.
        </span>
        {reload}
      </div>
    );
  }
  if (edits.changedOnServer) {
    return (
      <div
        className={styles.notice}
        role="status"
        data-testid="data-changed-on-server"
      >
        <span>This object changed on the server.</span>
        {reload}
      </div>
    );
  }
  return null;
}

/** The add row, the notices and Save, below the keys of either panel. */
export function DataControls(props: {
  edits: DataEditState;
  /** Names a new key may not take, beyond those being edited. */
  reservedKeys?: string[];
}) {
  const { edits, reservedKeys = [] } = props;
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const valid = isValidDataKey(newKey);
  const canAdd =
    valid && edits.isNewKey(newKey) && !reservedKeys.includes(newKey);
  return (
    <div className={styles.controls}>
      <div className={styles.addRow}>
        <Input
          label="New key"
          value={newKey}
          spellCheck={false}
          error={newKey !== "" && !valid ? INVALID_KEY : undefined}
          readOnly={edits.saving}
          data-testid="data-new-key"
          onChange={(e) => setNewKey(e.target.value)}
        />
        <ValueInput
          label="New value"
          testId="data-new-value"
          value={newValue}
          readOnly={edits.saving}
          onChange={setNewValue}
        />
        <Button
          size="sm"
          disabled={!canAdd || edits.saving}
          data-testid="data-add"
          onClick={() => {
            edits.setText(newKey, newValue);
            setNewKey("");
            setNewValue("");
          }}
        >
          Add
        </Button>
      </div>
      <ServerNotices edits={edits} />
      {edits.saveError ? (
        <ErrorNotice title="Save failed" message={edits.saveError} />
      ) : null}
      <div>
        <Button
          variant="primary"
          loading={edits.saving}
          disabled={!edits.dirty}
          data-testid="data-save"
          onClick={() => void edits.save()}
        >
          Save
        </Button>
      </div>
    </div>
  );
}
