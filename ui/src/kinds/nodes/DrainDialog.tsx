import { useEffect, useReducer, useRef, useState } from "react";
import { Button, Dialog, ErrorNotice } from "../../design";
import { api } from "../../ipc/api";
import { failureMessage } from "../../ipc/client";
import type { DrainEvent } from "../../ipc/generated/DrainEvent";
import type { DrainOutcome } from "../../ipc/generated/DrainOutcome";
import { drainReducer, INITIAL_DRAIN } from "./drainState";
import styles from "./nodes.module.css";

const OUTCOME_TEXT: Record<DrainOutcome, string> = {
  completed: "The node is drained.",
  refused: "The drain was refused.",
  failed: "The drain failed.",
  timedOut: "The drain timed out.",
  cancelled: "The drain was cancelled.",
};

export function DrainDialog(props: {
  clusterId: string;
  name: string;
  close(): void;
}) {
  const { clusterId, name, close } = props;
  const [force, setForce] = useState(false);
  const [emptyDir, setEmptyDir] = useState(false);
  const [minutes, setMinutes] = useState("5");
  const [state, dispatch] = useReducer(drainReducer, INITIAL_DRAIN);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const drainId = useRef<string | null>(null);
  const finished = useRef(false);
  const cancelSent = useRef(false);
  const mounted = useRef(true);

  function cancelIfRunning() {
    const id = drainId.current;
    if (!id || finished.current || cancelSent.current) return;
    cancelSent.current = true;
    api.nodeDrainCancel(id).catch(() => {});
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: cancelIfRunning only reads refs.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancelIfRunning();
    };
  }, []);

  const valid = /^[1-9]\d*$/.test(minutes);

  async function start() {
    if (!valid || started) return;
    setStarted(true);
    setError(null);
    try {
      const id = await api.nodeDrainStart(
        clusterId,
        name,
        {
          force,
          deleteEmptyDir: emptyDir,
          timeoutSeconds: Number(minutes) * 60,
        },
        (e: DrainEvent) => {
          if (e.type === "finished") finished.current = true;
          dispatch(e);
        },
      );
      drainId.current = id;
      // Left the screen while the start was in flight.
      if (!mounted.current) cancelIfRunning();
    } catch (e) {
      setError(failureMessage(e));
      setStarted(false);
    }
  }

  function closeDialog() {
    cancelIfRunning();
    close();
  }

  const running = started && state.outcome === null;
  const done = state.outcome !== null;

  let footer = (
    <>
      <Button variant="ghost" onClick={closeDialog}>
        Close
      </Button>
      <Button
        variant="primary"
        data-testid="drain-start"
        disabled={!valid || started}
        onClick={start}
      >
        Start
      </Button>
    </>
  );
  if (running) {
    footer = (
      <Button data-testid="drain-cancel" onClick={cancelIfRunning}>
        Cancel
      </Button>
    );
  } else if (done) {
    footer = (
      <Button variant="primary" data-testid="drain-close" onClick={closeDialog}>
        Close
      </Button>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) closeDialog();
      }}
      title={`Drain ${name}`}
      footer={footer}
    >
      {!started && !done ? (
        <div className={styles.options}>
          <label className={styles.option}>
            <input
              type="checkbox"
              data-testid="drain-force"
              checked={force}
              onChange={(e) => setForce(e.target.checked)}
            />
            Delete pods with no controller
          </label>
          <label className={styles.option}>
            <input
              type="checkbox"
              data-testid="drain-empty-dir"
              checked={emptyDir}
              onChange={(e) => setEmptyDir(e.target.checked)}
            />
            Delete pods using emptyDir
          </label>
          <label className={styles.option}>
            Timeout in minutes
            <input
              type="text"
              inputMode="numeric"
              data-testid="drain-timeout"
              value={minutes}
              aria-invalid={!valid}
              onChange={(e) => setMinutes(e.target.value)}
            />
          </label>
          <p className={styles.muted}>
            The node is cordoned first. DaemonSet and mirror pods are skipped.
          </p>
          {error ? (
            <ErrorNotice title="Drain failed to start" message={error} />
          ) : null}
        </div>
      ) : (
        <div className={styles.progress}>
          {state.cordoned ? <p>The node is cordoned.</p> : null}
          <ul className={styles.pods}>
            {state.pods.map((p) => (
              <li
                key={`${p.pod.namespace}/${p.pod.name}`}
                data-testid={`drain-pod-${p.pod.namespace}-${p.pod.name}`}
              >
                <span className={styles.podName}>
                  {p.pod.namespace}/{p.pod.name}
                </span>{" "}
                <span>{p.state}</span>
                {p.message ? (
                  <span className={styles.muted}> {p.message}</span>
                ) : null}
              </li>
            ))}
          </ul>
          {state.skipped.length > 0 ? (
            <p
              className={styles.muted}
              title={state.skipped
                .map((s) => `${s.pod.namespace}/${s.pod.name}`)
                .join("\n")}
            >
              {state.skipped.length} skipped (DaemonSet or mirror pods)
            </p>
          ) : null}
          {state.outcome ? (
            <p data-testid="drain-outcome">
              {OUTCOME_TEXT[state.outcome]}
              {state.message ? ` ${state.message}` : ""}
            </p>
          ) : null}
          {state.outcome && state.outcome !== "completed" ? (
            <p data-testid="drain-still-cordoned">
              The node stays cordoned. Uncordon it to allow scheduling again.
            </p>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
