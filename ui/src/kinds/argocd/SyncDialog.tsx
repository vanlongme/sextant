import { useState } from "react";
import { Button, Dialog, ErrorNotice, Input, toast } from "../../design";
import { api } from "../../ipc/api";
import type { ArgoSyncOptions } from "../../ipc/generated/ArgoSyncOptions";
import type { KubeObject } from "../objects";
import { isMultiSource } from "./application";
import styles from "./argocd.module.css";
import { nsName } from "./common";
import { Option } from "./Option";
import { SyncWindowsStep, useWindowsRetry } from "./syncWindows";

/** Sync <name>: the options, then the windows step when needed (spec G §9.1). */
export function SyncDialog(props: {
  clusterId: string;
  object: KubeObject;
  close(): void;
}) {
  const { clusterId, object: o, close } = props;
  const namespace = o.metadata.namespace ?? "";
  const { name } = o.metadata;
  const multi = isMultiSource(o);
  const [prune, setPrune] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  const [applyOnly, setApplyOnly] = useState(false);
  const [force, setForce] = useState(false);
  const [revision, setRevision] = useState("");

  function options(acknowledgeSyncWindows: boolean): ArgoSyncOptions {
    const wanted = revision.trim();
    return {
      revision: multi || wanted === "" ? null : wanted,
      prune,
      dryRun,
      force,
      strategy: applyOnly ? "apply" : "hook",
      syncOptions: [],
      resources: null,
      acknowledgeSyncWindows,
    };
  }

  const run = useWindowsRetry(
    (acknowledge) =>
      api.argocdSync(clusterId, namespace, name, options(acknowledge)),
    () => {
      toast.success("Sync started", nsName(o));
      close();
    },
  );
  const windows = run.step === "windows";
  const risky = (prune || force) && !dryRun;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !run.busy) close();
      }}
      title={windows ? "Sync windows cannot be checked" : `Sync ${name}`}
      testId="argocd-sync-dialog"
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
              Sync anyway
            </Button>
          ) : (
            <Button
              variant={risky ? "danger" : "primary"}
              loading={run.busy}
              onClick={() => void run.submit(false)}
              data-testid="argocd-sync-confirm"
            >
              {prune && !dryRun ? "Sync and prune" : "Sync"}
            </Button>
          )}
        </>
      }
    >
      {windows ? (
        <SyncWindowsStep clusterId={clusterId} app={o} action="sync" />
      ) : (
        <div className={styles.options}>
          <Option
            label="Prune"
            help="Delete resources that are no longer in git"
            checked={prune}
            onChange={setPrune}
            testId="argocd-sync-prune"
          />
          <Option
            label="Dry run"
            help="Report what would change, change nothing"
            checked={dryRun}
            onChange={setDryRun}
            testId="argocd-sync-dry-run"
          />
          <Option
            label="Apply only"
            help="Skip the sync hooks; plain apply"
            checked={applyOnly}
            onChange={setApplyOnly}
            testId="argocd-sync-apply-only"
          />
          <Option
            label="Force"
            help="Replace resources that cannot be patched"
            checked={force}
            onChange={setForce}
            testId="argocd-sync-force"
          />
          <Input
            label="Revision"
            placeholder="Empty for the target revision"
            value={revision}
            disabled={multi}
            help={
              multi
                ? "This Application has several sources; each syncs at its target revision."
                : undefined
            }
            onChange={(e) => setRevision(e.target.value)}
            data-testid="argocd-sync-revision"
          />
        </div>
      )}
      {run.error ? (
        <ErrorNotice title="Could not sync" message={run.error} />
      ) : null}
    </Dialog>
  );
}
