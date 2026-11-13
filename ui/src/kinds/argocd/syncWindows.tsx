import { useEffect, useState } from "react";
import { Spinner } from "../../design";
import { api } from "../../ipc/api";
import { failureMessage, IpcFailure } from "../../ipc/client";
import type { KubeObject } from "../objects";
import { SyncWindowTable } from "./AppProjectDetail";
import { projectLocation } from "./application";
import { syncWindows } from "./appProject";
import styles from "./argocd.module.css";
import { APP_PROJECTS } from "./common";

const WINDOWS_UNVERIFIED = "syncWindowsUnverified";

/** The backend's answer when the project may have sync windows (contract §5). */
export function isWindowsUnverified(error: unknown): boolean {
  return (
    error instanceof IpcFailure &&
    error.code === "Conflict" &&
    error.details === WINDOWS_UNVERIFIED
  );
}

/**
 * Sends a sync or roll back. A sync-window refusal moves the dialog to the windows
 * step, where the user may send it again with acknowledgement (spec G §9.3). Any
 * other failure, and any failure of the acknowledged call, is kept as `error`.
 */
export function useWindowsRetry(
  send: (acknowledge: boolean) => Promise<void>,
  onDone: () => void,
): {
  step: "form" | "windows";
  busy: boolean;
  error: string | null;
  submit(acknowledge: boolean): Promise<void>;
} {
  const [step, setStep] = useState<"form" | "windows">("form");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(acknowledge: boolean): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await send(acknowledge);
      onDone();
    } catch (e) {
      if (!acknowledge && isWindowsUnverified(e)) setStep("windows");
      else setError(failureMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return { step, busy, error, submit };
}

type Project =
  | { state: "loading" }
  | { state: "read"; project: KubeObject }
  | { state: "failed" };

/** The windows step's body: what may block the action, and the project's windows. */
export function SyncWindowsStep(props: {
  clusterId: string;
  app: KubeObject;
  action: "sync" | "roll back";
}) {
  const { clusterId, app, action } = props;
  const at = projectLocation(app);
  const [project, setProject] = useState<Project>({ state: "loading" });
  useEffect(() => {
    let current = true;
    setProject({ state: "loading" });
    api
      .resourceGet(clusterId, APP_PROJECTS, at.namespace, at.name)
      .then((p) => {
        if (current)
          setProject({ state: "read", project: p as unknown as KubeObject });
      })
      .catch(() => {
        if (current) setProject({ state: "failed" });
      });
    return () => {
      current = false;
    };
  }, [clusterId, at.namespace, at.name]);
  return (
    <div className={styles.options} data-testid="argocd-windows-dialog">
      <p className={styles.refusal}>
        The project {at.name} may have sync windows that block this {action}.
        SkoposIDE cannot check them.
      </p>
      {project.state === "loading" ? (
        <Spinner label="Loading the project" />
      ) : project.state === "failed" ? (
        <p className={styles.muted}>
          The project {at.namespace}/{at.name} cannot be read.
        </p>
      ) : (
        <SyncWindowTable windows={syncWindows(project.project)} />
      )}
    </div>
  );
}
