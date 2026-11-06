import { useId, useState } from "react";
import { Button, Dialog, toast } from "../../design";
import { api } from "../../ipc/api";
import { failureMessage } from "../../ipc/client";
import type { Propagation } from "../../ipc/generated/Propagation";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import { type KubeObject, objectKey } from "../../kinds/objects";
import styles from "./ResourceScreen.module.css";

/** How many deletes run at once, so a bulk delete cannot flood the backend. */
const CONCURRENT_DELETES = 8;

const PROPAGATION: { value: Propagation; label: string; help: string }[] = [
  {
    value: "background",
    label: "Background",
    help: "Delete now, and the objects it owns afterwards.",
  },
  {
    value: "foreground",
    label: "Foreground",
    help: "Delete the objects it owns first, then this.",
  },
  { value: "orphan", label: "Orphan", help: "Keep the objects it owns." },
];

function displayName(o: KubeObject): string {
  const { namespace, name } = o.metadata;
  return namespace ? `${namespace}/${name}` : name;
}

/** Runs every delete, and gives what failed with the API server's message. */
async function deleteAll(
  clusterId: string,
  resource: ResourceRef,
  objects: KubeObject[],
  propagation: Propagation,
): Promise<{ object: KubeObject; message: string }[]> {
  const queue = [...objects];
  const failures: { object: KubeObject; message: string }[] = [];
  async function worker(): Promise<void> {
    for (let o = queue.shift(); o; o = queue.shift()) {
      try {
        await api.resourceDelete(
          clusterId,
          resource,
          o.metadata.namespace ?? null,
          o.metadata.name,
          propagation,
        );
      } catch (error) {
        failures.push({ object: o, message: failureMessage(error) });
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENT_DELETES }, worker));
  return failures;
}

/**
 * Asks before deleting, naming every target, and then deletes. It closes when that
 * is done, and a failure of any object shows in a toast with the API's message.
 */
export function DeleteDialog(props: {
  clusterId: string;
  resource: ResourceRef;
  objects: KubeObject[];
  onCancel(): void;
  /** Called after trying them all, with the keys of the objects that are gone. */
  onDeleted(keys: string[]): void;
}) {
  const { clusterId, resource, objects } = props;
  const [propagation, setPropagation] = useState<Propagation>("background");
  const [busy, setBusy] = useState(false);
  const radioGroup = useId();
  const { kind } = resource;
  const single = objects.length === 1;
  const subject = single
    ? `${kind} ${displayName(objects[0])}`
    : `${objects.length} ${kind} objects`;

  async function confirm(): Promise<void> {
    setBusy(true);
    const failures = await deleteAll(clusterId, resource, objects, propagation);
    if (failures.length === 1 && single) {
      toast.error(`Could not delete ${subject}`, failures[0].message);
    } else if (failures.length > 0) {
      toast.error(
        `Could not delete ${failures.length} of ${subject}`,
        failures
          .map((f) => `${displayName(f.object)}: ${f.message}`)
          .join("\n"),
      );
    }
    const failed = new Set(failures.map((f) => f.object));
    props.onDeleted(
      objects.filter((o) => !failed.has(o)).map((o) => objectKey(o)),
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) props.onCancel();
      }}
      title={`Delete ${subject}?`}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={props.onCancel}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={busy}
            onClick={() => void confirm()}
            data-testid="delete-confirm"
          >
            Delete
          </Button>
        </>
      }
    >
      {single ? null : (
        <ul className={styles.deleteList}>
          {objects.map((o) => (
            <li key={objectKey(o)}>{displayName(o)}</li>
          ))}
        </ul>
      )}
      <fieldset className={styles.propagation} disabled={busy}>
        <legend className={styles.legend}>
          Objects owned by what you delete
        </legend>
        {PROPAGATION.map((p) => (
          <label key={p.value} className={styles.radio}>
            <input
              type="radio"
              name={radioGroup}
              value={p.value}
              checked={propagation === p.value}
              onChange={() => setPropagation(p.value)}
            />
            <span>
              {p.label}
              <span className={styles.radioHelp}> {p.help}</span>
            </span>
          </label>
        ))}
      </fieldset>
    </Dialog>
  );
}
