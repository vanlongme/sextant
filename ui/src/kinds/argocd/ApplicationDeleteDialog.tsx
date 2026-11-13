import { useState } from "react";
import { Button, Dialog, RadioGroup, type RadioOption } from "../../design";
import {
  displayName,
  reportDeleteFailures,
  runEach,
} from "../../features/resources/DeleteDialog";
import { api } from "../../ipc/api";
import { objectKey } from "../objects";
import type { DeleteDialogProps } from "../registry";
import styles from "./argocd.module.css";

type Choice = "cascade" | "keep";

const CHOICES: RadioOption<Choice>[] = [
  {
    value: "cascade",
    label: "Delete the resources too",
    description:
      "Sets the finalizer resources-finalizer.argocd.argoproj.io; Argo CD deletes what it deployed, then the Application.",
  },
  {
    value: "keep",
    label: "Keep the resources",
    description:
      "Clears the finalizers; the resources stay and Argo CD no longer manages them.",
  },
];

/**
 * Deletes one or more Applications, with or without what they deployed. One choice
 * applies to all; each is deleted by its own `argocd_delete` call (spec G §9.4).
 */
export function ApplicationDeleteDialog(props: DeleteDialogProps) {
  const { clusterId, objects } = props;
  const [choice, setChoice] = useState<Choice>("cascade");
  const [busy, setBusy] = useState(false);
  const single = objects.length === 1;
  const cascade = choice === "cascade";
  const subject = single
    ? `Application ${displayName(objects[0])}`
    : `${objects.length} Applications`;
  const okLabel = cascade
    ? "Delete with resources"
    : single
      ? "Delete the Application"
      : "Delete the Applications";

  async function confirm(): Promise<void> {
    setBusy(true);
    const failures = await runEach(objects, (o) =>
      api.argocdDelete(
        clusterId,
        o.metadata.namespace ?? "",
        o.metadata.name,
        cascade,
      ),
    );
    reportDeleteFailures(subject, single, failures);
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
      testId="argocd-delete-dialog"
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
            {okLabel}
          </Button>
        </>
      }
    >
      {single ? null : (
        <ul className={styles.names}>
          {objects.map((o) => (
            <li key={objectKey(o)}>{displayName(o)}</li>
          ))}
        </ul>
      )}
      <RadioGroup
        legend="What happens to the resources it deployed"
        value={choice}
        options={CHOICES}
        onChange={(value) => setChoice(value)}
        testId="argocd-delete-cascade"
      />
    </Dialog>
  );
}
