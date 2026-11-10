import { useEffect, useState } from "react";
import {
  ConfirmDialog,
  ErrorNotice,
  Select,
  Spinner,
  Switch,
} from "../../design";
import { api } from "../../ipc/api";
import type { IpcFailure } from "../../ipc/client";
import type { HelmRevision } from "../../ipc/generated/HelmRevision";
import { asFailure, counted, useHelm } from "../../stores/helm";
import styles from "./Helm.module.css";

const ROLLBACK_TEXT =
  "helm rollback writes a new revision with the chart and values of the one you pick. It runs with --wait, and the objects change as the new revision applies.";

/** Roll back (spec §11.2). `revision` is the one to choose first, else the newest. */
export function RollbackDialog(props: {
  clusterId: string;
  namespace: string;
  name: string;
  /** The release's current revision, which is not offered. */
  current: number;
  revision?: number;
  onClose(): void;
}) {
  const { clusterId, namespace, name, current, onClose } = props;
  const startRollback = useHelm((s) => s.startRollback);
  const [history, setHistory] = useState<HelmRevision[] | null>(null);
  const [error, setError] = useState<IpcFailure | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [chosen, setChosen] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the read on Retry.
  useEffect(() => {
    let live = true;
    setError(null);
    api.helmReleaseHistory(clusterId, namespace, name).then(
      (revisions) => {
        if (live) setHistory(revisions);
      },
      (e: unknown) => {
        if (live) setError(asFailure(e));
      },
    );
    return () => {
      live = false;
    };
  }, [clusterId, namespace, name, attempt]);

  const options = (history ?? [])
    .filter((r) => r.revision !== current)
    .sort((a, b) => b.revision - a.revision);
  const first =
    options.find((r) => r.revision === props.revision) ?? options[0];
  const value = chosen ?? (first ? String(first.revision) : null);

  let picker = null;
  if (error) {
    picker = (
      <ErrorNotice
        title="Could not read the release history"
        message={error.message}
        details={error.details}
        onRetry={() => setAttempt((n) => n + 1)}
      />
    );
  } else if (history === null) {
    picker = <Spinner />;
  } else if (value !== null) {
    picker = (
      <Select
        label="Roll back to"
        value={value}
        options={options.map((r) => ({
          value: String(r.revision),
          label: `Revision ${r.revision} · ${r.chart} · ${r.status}`,
        }))}
        onChange={setChosen}
        testId="helm-rollback-revision"
      />
    );
  }

  return (
    <ConfirmDialog
      open
      title={`Roll back ${name} in ${namespace}?`}
      body={
        <>
          <p className={styles.paragraph}>{ROLLBACK_TEXT}</p>
          {picker}
        </>
      }
      confirmLabel="Roll back"
      danger
      confirmDisabled={value === null}
      testId="helm-rollback-dialog"
      onConfirm={() => {
        if (value === null) return;
        void startRollback(clusterId, namespace, name, Number(value));
        onClose();
      }}
      onCancel={onClose}
    />
  );
}

/** Uninstall (spec §11.3); a release that is `uninstalled` only loses its history. */
export function UninstallDialog(props: {
  clusterId: string;
  namespace: string;
  name: string;
  status: string;
  onClose(): void;
}) {
  const { clusterId, namespace, name, onClose } = props;
  const startUninstall = useHelm((s) => s.startUninstall);
  const historyOnly = props.status === "uninstalled";
  const [objects, setObjects] = useState<number | null>(null);
  const [keepHistory, setKeepHistory] = useState(false);

  useEffect(() => {
    if (historyOnly) return;
    let live = true;
    api.helmReleaseGet(clusterId, namespace, name).then(
      (detail) => {
        if (live) setObjects(detail.resources.filter((r) => r.ref).length);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [clusterId, namespace, name, historyOnly]);

  const count =
    objects === null
      ? ""
      : ` (${counted(objects, "object", "objects")} in this cluster)`;
  const text = historyOnly
    ? "helm deletes the history it kept for this release. Its objects are already gone."
    : `helm deletes the objects the release created${count}. PersistentVolumeClaims that charts keep stay.`;

  return (
    <ConfirmDialog
      open
      title={`Uninstall ${name} from ${namespace}?`}
      body={
        <>
          <p className={styles.paragraph}>{text}</p>
          {historyOnly ? null : (
            <Switch
              label="Keep the release history"
              description="helm uninstall --keep-history; you can roll back to it later from the CLI"
              checked={keepHistory}
              onChange={setKeepHistory}
              testId="helm-uninstall-keep-history"
            />
          )}
        </>
      }
      confirmLabel="Uninstall"
      danger
      testId="helm-uninstall-dialog"
      onConfirm={() => {
        void startUninstall(
          clusterId,
          namespace,
          name,
          historyOnly ? false : keepHistory,
        );
        onClose();
      }}
      onCancel={onClose}
    />
  );
}
