import type { ReactNode } from "react";
import { Select, StatusDot, Switch } from "../../design";
import type { Tone } from "../../design/Badge";
import {
  isPodTab,
  type LogsDockTab,
  type LogTabOptions,
} from "../../stores/dock";
import styles from "./LogsTab.module.css";
import type { LogSources } from "./logSources";
import type { LogStatus } from "./useLogStream";

export const STATUS_LABELS: Record<LogStatus, string> = {
  connecting: "Connecting",
  following: "Following",
  paused: "Paused",
  previous: "Previous instance",
  ended: "Ended",
  failed: "Failed",
};

/** Warning, nominal, offline and critical (spec §5.5) in the dot's tones. */
const STATUS_TONES: Record<LogStatus, Tone> = {
  connecting: "warn",
  following: "ok",
  paused: "neutral",
  previous: "neutral",
  ended: "neutral",
  failed: "danger",
};

export function allPodsLabel(count: number): string {
  if (count === 0) return "All Pods";
  if (count === 1) return "All 1 Pod";
  return `All ${count.toLocaleString("en-US")} Pods`;
}

type Lines = "100" | "1000" | "all";

const LINES: { value: Lines; label: string }[] = [
  { value: "100", label: "Last 100 lines" },
  { value: "1000", label: "Last 1,000 lines" },
  { value: "all", label: "All lines" },
];

/** The Container choice's value for every container. No container name has a "*". */
const ALL_CONTAINERS = "*";

function linesValue(tail: number | null): Lines {
  if (tail === null) return "all";
  return tail === 100 ? "100" : "1000";
}

/** The Logs tab's toolbar (spec §6.1). `trailing` sits between the spacer and the status. */
export function LogsToolbar(props: {
  tab: LogsDockTab;
  sources: LogSources;
  status: LogStatus;
  onChange(patch: Partial<LogTabOptions>): void;
  trailing?: ReactNode;
}) {
  const { tab, sources, status, onChange } = props;
  const { options } = tab;

  // "all" is the choice for every Pod, so a Pod of that name cannot be told apart.
  const pods = sources.pods.filter((p) => p !== "all");
  if (options.pod !== "all" && !pods.includes(options.pod))
    pods.push(options.pod);
  const containers = sources.containers.map((c) => ({
    value: c.name,
    label: c.crashLooping ? `${c.name} (CrashLoopBackOff)` : c.name,
  }));
  if (
    options.container !== null &&
    !containers.some((c) => c.value === options.container)
  ) {
    containers.push({ value: options.container, label: options.container });
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset brings a border and a legend that a toolbar does not want.
    <div className={styles.toolbar} role="group" aria-label="Log options">
      {isPodTab(tab) ? null : (
        <Select
          label="Pods"
          hideLabel
          width={200}
          testId="logs-pods"
          value={options.pod}
          options={[
            { value: "all", label: allPodsLabel(sources.pods.length) },
            ...pods.map((p) => ({ value: p, label: p })),
          ]}
          onChange={(pod) => onChange({ pod, previous: false })}
        />
      )}
      {sources.containers.length >= 2 ? (
        <Select
          label="Container"
          hideLabel
          width={200}
          testId="logs-container"
          value={options.container ?? ALL_CONTAINERS}
          options={[
            { value: ALL_CONTAINERS, label: "All containers" },
            ...containers,
          ]}
          onChange={(v) =>
            onChange({
              container: v === ALL_CONTAINERS ? null : v,
              previous: false,
            })
          }
        />
      ) : null}
      <Select<Lines>
        label="Lines"
        hideLabel
        width={148}
        testId="logs-lines"
        value={linesValue(options.tail)}
        options={LINES}
        onChange={(v) => onChange({ tail: v === "all" ? null : Number(v) })}
      />
      <Switch
        size="sm"
        label="Follow"
        checked={options.follow}
        onChange={(follow) => onChange({ follow })}
        testId="logs-follow"
      />
      <Switch
        size="sm"
        label="Previous"
        checked={options.previous}
        disabled={!options.previous && !sources.previousAllowed}
        onChange={(previous) => onChange({ previous })}
        testId="logs-previous"
      />
      <Switch
        size="sm"
        label="Timestamps"
        checked={options.timestamps}
        onChange={(timestamps) => onChange({ timestamps })}
        testId="logs-timestamps"
      />
      <Switch
        size="sm"
        label="Wrap"
        checked={options.wrap}
        onChange={(wrap) => onChange({ wrap })}
        testId="logs-wrap"
      />
      <span className={styles.spacer} />
      {props.trailing}
      <span className={styles.status} data-testid="logs-status">
        <StatusDot tone={STATUS_TONES[status]} label={STATUS_LABELS[status]} />
        {/* The dot already names the status for assistive technology. */}
        <span aria-hidden="true">{STATUS_LABELS[status]}</span>
      </span>
    </div>
  );
}
