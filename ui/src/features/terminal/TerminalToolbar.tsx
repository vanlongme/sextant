import { RefreshCw, Unplug } from "lucide-react";
import { useState } from "react";
import { Button, ConfirmDialog, Select, StatusDot } from "../../design";
import type { Tone } from "../../design/Badge";
import {
  type PodSessionDockTab,
  type SessionDockTab,
  useDock,
} from "../../stores/dock";
import {
  type NodeShellPrompt,
  nodeShellImage,
  nodeShellPrompt,
} from "./nodeShell";
import { useContainerChoices } from "./podContainers";
import { reconnect, type SessionInfo, useSession } from "./sessions";
import styles from "./TerminalTab.module.css";

export const TERMINAL_CONTEXT_NOTE =
  "kubectl and helm in this tab use this cluster's context.";

/** The status dot's tone and label (spec §5.6). */
export function statusOf(
  kind: SessionDockTab["kind"],
  info: SessionInfo,
): { tone: Tone; label: string } {
  switch (info.status) {
    case "connecting":
      return { tone: "warn", label: "Connecting…" };
    case "connected":
      return {
        tone: "ok",
        label:
          kind === "terminal"
            ? "Local shell"
            : kind === "attach"
              ? "Attached"
              : "Connected",
      };
    case "ended":
      return {
        tone: "neutral",
        label:
          info.exitCode === null
            ? "Exited"
            : `Exited · status ${info.exitCode}`,
      };
    case "failed":
      return { tone: "danger", label: "Not connected" };
    case "notConnected":
      return { tone: "neutral", label: "Not connected" };
  }
}

/** The Attach note (spec §6.1). */
export function attachNote(container: string, tty: boolean): string {
  return tty
    ? `Attached to container ${container} (PID 1). Input goes to that process.`
    : `Attached to container ${container} (PID 1). It runs without a TTY (tty: false), so input is off and only its output shows.`;
}

function podTabOf(tab: SessionDockTab): PodSessionDockTab | null {
  return tab.kind === "shell" || tab.kind === "attach" ? tab : null;
}

/** The bar above a terminal (spec §6.1). */
export function TerminalToolbar({ tab }: { tab: SessionDockTab }) {
  const info = useSession(tab.id);
  const podTab = podTabOf(tab);
  const choices = useContainerChoices(podTab);
  const [prompt, setPrompt] = useState<NodeShellPrompt | null>(null);
  const status = statusOf(tab.kind, info);

  // The tab's own container stays a choice even when the row no longer lists it.
  const own = podTab?.container ?? null;
  const options =
    own !== null && !choices.some((c) => c.value === own)
      ? [...choices, { value: own, label: own }]
      : choices;
  // A restored tab may have no container: the backend then takes the first one.
  const container = own ?? choices[0]?.value ?? null;
  const note =
    tab.kind === "attach" && container !== null && info.tty !== null
      ? attachNote(container, info.tty)
      : null;

  function changeContainer(next: string): void {
    if (!podTab || next === podTab.container) return;
    useDock.getState().setContainer(podTab.id, next);
    reconnect({ ...podTab, container: next });
  }

  async function askReconnect(): Promise<void> {
    if (tab.kind !== "nodeShell") {
      reconnect(tab);
      return;
    }
    setPrompt(nodeShellPrompt(tab.node, await nodeShellImage(tab.clusterId)));
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset brings a border and a legend that a toolbar does not want.
    <div className={styles.toolbar} role="group" aria-label="Terminal options">
      {podTab && choices.length >= 2 ? (
        <Select
          label="Container"
          hideLabel
          width={200}
          testId={`${podTab.kind}-container`}
          value={container ?? ""}
          options={options}
          onChange={changeContainer}
        />
      ) : null}
      <span className={styles.status} data-testid="terminal-status">
        <StatusDot tone={status.tone} label={status.label} />
        {/* The dot already names the status for assistive technology. */}
        <span aria-hidden="true">{status.label}</span>
      </span>
      {tab.kind === "terminal" ? (
        <span className={styles.note}>{TERMINAL_CONTEXT_NOTE}</span>
      ) : null}
      {note !== null ? (
        <span className={styles.note} data-testid="attach-note">
          {note}
        </span>
      ) : null}
      <span className={styles.spacer} />
      {tab.kind === "attach" ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => useDock.getState().close(tab.id)}
          data-testid="attach-detach"
        >
          <Unplug size={14} aria-hidden="true" />
          Detach
        </Button>
      ) : (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void askReconnect()}
          data-testid="terminal-reconnect"
        >
          <RefreshCw size={14} aria-hidden="true" />
          Reconnect
        </Button>
      )}
      {prompt ? (
        <ConfirmDialog
          open
          title={prompt.title}
          body={prompt.body}
          confirmLabel={prompt.confirmLabel}
          danger
          onConfirm={() => {
            setPrompt(null);
            reconnect(tab);
          }}
          onCancel={() => setPrompt(null)}
        />
      ) : null}
    </div>
  );
}
