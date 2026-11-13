import { type ReactNode, useState } from "react";
import { Button, Dialog, ErrorNotice, Select, toast } from "../../design";
import { useNow } from "../../design/VirtualTable";
import { api } from "../../ipc/api";
import { formatAge, type KubeObject } from "../objects";
import { rollbackRefusal, rollbackTargets } from "./application";
import styles from "./argocd.module.css";
import { nsName } from "./common";
import { Option } from "./Option";
import { SyncWindowsStep, useWindowsRetry } from "./syncWindows";

/** Roll back <name>?: a history entry, Prune and Dry run (spec G §9.2). */
export function RollbackDialog(props: {
  clusterId: string;
  object: KubeObject;
  close(): void;
}) {
  const { clusterId, object: o, close } = props;
  const namespace = o.metadata.namespace ?? "";
  const { name } = o.metadata;
  const now = useNow();
  const refusal = rollbackRefusal(o);
  const targets = rollbackTargets(o);
  const [historyId, setHistoryId] = useState(String(targets[0]?.id ?? ""));
  const [prune, setPrune] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  const run = useWindowsRetry(
    (acknowledgeSyncWindows) =>
      api.argocdRollback(clusterId, namespace, name, {
        historyId: Number(historyId),
        prune,
        dryRun,
        acknowledgeSyncWindows,
      }),
    () => {
      toast.success("Rollback started", nsName(o));
      close();
    },
  );
  const windows = run.step === "windows";

  let body: ReactNode;
  if (windows) {
    body = <SyncWindowsStep clusterId={clusterId} app={o} action="roll back" />;
  } else if (refusal) {
    body = (
      <p className={styles.refusal} data-testid="argocd-rollback-refusal">
        {refusal}
      </p>
    );
  } else {
    body = (
      <div className={styles.options}>
        <Select
          label="Deploy again"
          value={historyId}
          options={targets.map((t) => ({
            value: String(t.id),
            label: `${t.id} · ${t.revision} · ${formatAge(t.deployedAt, now)}`,
          }))}
          onChange={setHistoryId}
          testId="argocd-rollback-target"
        />
        <Option
          label="Prune"
          help="Delete resources that are not in that revision"
          checked={prune}
          onChange={setPrune}
          testId="argocd-rollback-prune"
        />
        <Option
          label="Dry run"
          help="Report what would change, change nothing"
          checked={dryRun}
          onChange={setDryRun}
          testId="argocd-rollback-dry-run"
        />
      </div>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !run.busy) close();
      }}
      title={windows ? "Sync windows cannot be checked" : `Roll back ${name}?`}
      testId="argocd-rollback-dialog"
      footer={
        <>
          <Button variant="ghost" disabled={run.busy} onClick={close}>
            Cancel
          </Button>
          {windows ? (
            <Button
              variant="danger"
              loading={run.busy}
              onClick={() => void run.submit(true)}
              data-testid="argocd-windows-confirm"
            >
              Roll back anyway
            </Button>
          ) : (
            <Button
              variant="danger"
              loading={run.busy}
              disabled={refusal !== null}
              onClick={() => void run.submit(false)}
              data-testid="argocd-rollback-confirm"
            >
              Roll back
            </Button>
          )}
        </>
      }
    >
      {body}
      {run.error ? (
        <ErrorNotice title="Could not roll back" message={run.error} />
      ) : null}
    </Dialog>
  );
}
