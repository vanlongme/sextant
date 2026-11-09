import { useId, useRef, useState } from "react";
import {
  Button,
  Dialog,
  ErrorNotice,
  Input,
  Select,
  toast,
} from "../../design";
import { failureMessage } from "../../ipc/client";
import type { PortForward } from "../../ipc/generated/PortForward";
import type { PortForwardKind } from "../../ipc/generated/PortForwardKind";
import type { KubeObject } from "../../kinds/objects";
import { createAndStart, openInBrowser } from "./operations";
import styles from "./PortForward.module.css";
import {
  BROWSER_PORTS,
  type Check,
  checkLocalPort,
  checkTargetPort,
  choiceLabel,
  portChoices,
} from "./ports";

const TEXT: Record<PortForwardKind, string> = {
  service:
    "SkoposIDE listens on 127.0.0.1 and sends each connection through the API server to a Ready Pod of the Service.",
  pod: "SkoposIDE listens on 127.0.0.1 and sends each connection through the API server to this Pod.",
};

/** The start dialog (spec §5.3): Start adds the definition and starts it at once. */
export function PortForwardDialog(props: {
  clusterId: string;
  kind: PortForwardKind;
  object: KubeObject;
  /** The port of the Forward button that opened the dialog. */
  port?: number;
  close(): void;
}) {
  const { clusterId, kind, object, close } = props;
  const { name, namespace = "" } = object.metadata;
  // Read once, so a live update of the object cannot move the choice.
  const [choices] = useState(() => portChoices(kind, object));
  const [chosen, setChosen] = useState<number | null>(() =>
    props.port !== undefined && choices.some((c) => c.port === props.port)
      ? props.port
      : (choices[0]?.port ?? null),
  );
  const [typedTarget, setTypedTarget] = useState("");
  const [local, setLocal] = useState("");
  // Decided by the port the dialog opens with; a later choice does not change it.
  const [openBrowser, setOpenBrowser] = useState(
    () => chosen !== null && BROWSER_PORTS.has(chosen),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set on the first press, before React has drawn the button disabled.
  const starting = useRef(false);
  const boxId = useId();
  const hintId = useId();

  const target: Check<number> =
    chosen !== null
      ? { ok: true, value: chosen }
      : checkTargetPort(typedTarget);
  const localPort = checkLocalPort(local);
  const valid = target.ok && localPort.ok;

  async function start(): Promise<void> {
    if (!target.ok || !localPort.ok || starting.current) return;
    starting.current = true;
    const targetPort = target.value;
    const wanted = localPort.value;
    setBusy(true);
    setError(null);
    let answer: PortForward;
    try {
      answer = await createAndStart({
        clusterId,
        target: { kind, namespace, name },
        targetPort,
        localPort: wanted,
      });
    } catch (e) {
      starting.current = false;
      setBusy(false);
      setError(failureMessage(e));
      return;
    }
    close();
    // A Disconnect during the start leaves a stopped forward and no address to show.
    if (answer.state !== "running" || answer.boundPort === null) return;
    const opening = openBrowser ? " · opening it in your browser" : "";
    toast.success(
      `Forwarding 127.0.0.1:${answer.boundPort}`,
      `to ${kind}/${name}:${targetPort} in ${namespace}${opening}`,
    );
    if (!openBrowser) return;
    try {
      await openInBrowser(answer);
    } catch (e) {
      toast.error("Could not open the browser", failureMessage(e));
    }
  }

  return (
    <Dialog
      open
      testId="pf-dialog"
      title={`Port forward ${kind}/${name}`}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            data-testid="pf-start"
            disabled={!valid}
            loading={busy}
            onClick={() => void start()}
          >
            Start
          </Button>
        </>
      }
    >
      <p className={styles.intro}>{TEXT[kind]}</p>
      <div className={styles.fields}>
        {chosen !== null ? (
          <Select
            label="Target port"
            testId="pf-target-port"
            value={String(chosen)}
            options={choices.map((c) => ({
              value: String(c.port),
              label: choiceLabel(c),
            }))}
            onChange={(value) => {
              setChosen(Number(value));
              setError(null);
            }}
          />
        ) : (
          <Input
            label="Target port"
            inputMode="numeric"
            data-testid="pf-target-port"
            value={typedTarget}
            onChange={(e) => {
              setTypedTarget(e.target.value);
              setError(null);
            }}
            error={target.ok ? undefined : (target.message ?? undefined)}
          />
        )}
        <Input
          label="Local port, empty for a random one"
          inputMode="numeric"
          data-testid="pf-local-port"
          value={local}
          onChange={(e) => {
            setLocal(e.target.value);
            setError(null);
          }}
          error={localPort.ok ? undefined : (localPort.message ?? undefined)}
        />
        <div className={styles.check}>
          <input
            id={boxId}
            type="checkbox"
            data-testid="pf-open-browser"
            checked={openBrowser}
            aria-describedby={hintId}
            onChange={(e) => {
              setOpenBrowser(e.target.checked);
              setError(null);
            }}
          />
          <div className={styles.checkText}>
            <label htmlFor={boxId}>Open in the browser when it starts</label>
            <span id={hintId} className={styles.hint}>
              Opens http://127.0.0.1 and the local port
            </span>
          </div>
        </div>
      </div>
      {error !== null ? (
        <div className={styles.error} data-testid="pf-error">
          <ErrorNotice title="Port forward failed" message={error} />
        </div>
      ) : null}
    </Dialog>
  );
}
