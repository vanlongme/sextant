import { CircleAlert, Info } from "lucide-react";
import { type ReactNode, useRef } from "react";
import { useNavigate } from "react-router";
import { Badge, Button, Segmented, Spinner } from "../../design";
import type { IpcFailure } from "../../ipc/client";
import type { MetricName } from "../../ipc/generated/MetricName";
import type { MetricsProvider } from "../../ipc/generated/MetricsProvider";
import type { MetricsRange } from "../../ipc/generated/MetricsRange";
import type { MetricsResult } from "../../ipc/generated/MetricsResult";
import type { MetricsTarget } from "../../ipc/generated/MetricsTarget";
import type { UsageOf } from "../../ipc/generated/UsageOf";
import {
  askQuery,
  askUsage,
  type MetricsView,
  queryKey,
  refreshProvider,
  useMetrics,
} from "../../stores/metrics";
import { chartsPath } from "../helm/helmText";
import { settingsPath } from "../settings/paths";
import { type Point, usablePoints } from "./chartGeometry";
import {
  type ChartDef,
  chartsFor,
  factsFromResult,
  type MetricsSource,
  mergeFacts,
  RANGE_PERIOD,
  serverNote,
  type TargetFacts,
} from "./charts";
import {
  useProvider,
  useQueryWatch,
  useSecondsUntil,
  useUsageWatch,
} from "./hooks";
import styles from "./MetricsPanel.module.css";
import { liveText, rollingDomain, rollingMinutes, sumHistory } from "./rolling";
import { type ChartSeries, TimeChart } from "./TimeChart";

/** How a target reads under metrics-server: which snapshot, and which of its items. */
export interface UsageSource {
  of: UsageOf;
  namespace: string | null;
  /** The items summed into the charts; null sums every item. */
  keys: string[] | null;
}

export interface MetricsPanelProps {
  clusterId: string;
  clusterName: string;
  target: MetricsTarget;
  facts: TargetFacts;
  /** How the target reads under metrics-server; null for a PVC. */
  usage: UsageSource | null;
  /** The Overview's grid, or the drawer's single column. */
  layout: "grid" | "column";
  /** The object's own empty text (spec §10.4), or null for the shared one. */
  objectEmpty?: (
    source: MetricsSource,
    rangeStart: number | null,
  ) => string | null;
}

type PrometheusProvider = Extract<MetricsProvider, { kind: "prometheus" }>;
type ServerProvider = Extract<MetricsProvider, { kind: "metricsServer" }>;

const RANGES: { value: MetricsRange; label: string }[] = [
  { value: "1h", label: "1h" },
  { value: "6h", label: "6h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
];

const VIEWS: { value: MetricsView; label: string }[] = [
  { value: "chart", label: "Chart" },
  { value: "table", label: "Table" },
];

const FORBIDDEN_NOTE =
  "Metrics are not shown: the nodes API is forbidden, so usage cannot be summed.";

function sourceText(provider: PrometheusProvider | ServerProvider): string {
  if (provider.kind === "prometheus") {
    const how =
      provider.chosenBy === "setting"
        ? "pinned in the cluster settings"
        : "autodetected";
    return `Prometheus ${provider.namespace}/${provider.service}:${provider.port}, ${how}, through the API server proxy`;
  }
  const how =
    provider.chosenBy === "setting"
      ? "set in the cluster settings."
      : "autodetected: no Prometheus Service found.";
  return `metrics-server, ${how} Samples every 15 s while the cluster is connected`;
}

function Note(props: { text: string; action?: { label: string; to: string } }) {
  const navigate = useNavigate();
  const { action } = props;
  return (
    <div role="note" className={styles.note} data-testid="metrics-note">
      <Info size={16} aria-hidden="true" />
      <p className={styles.noteText}>{props.text}</p>
      {action ? (
        <Button
          variant="secondary"
          size="sm"
          data-testid="metrics-note-action"
          onClick={() => navigate(action.to)}
        >
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}

function ErrorBlock(props: {
  clusterId: string;
  title: string;
  error: IpcFailure;
  busy: boolean;
  onRetry(): void;
}) {
  const navigate = useNavigate();
  return (
    <div role="alert" className={styles.error} data-testid="metrics-error">
      <CircleAlert size={16} aria-hidden="true" />
      <div className={styles.errorText}>
        <strong>{props.title}</strong>
        <p>{props.error.message}</p>
      </div>
      <div className={styles.errorActions}>
        <Button
          variant="secondary"
          size="sm"
          disabled={props.busy}
          onClick={props.onRetry}
          data-testid="metrics-retry"
        >
          Retry
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate(settingsPath(props.clusterId))}
          data-testid="metrics-settings"
        >
          Cluster settings
        </Button>
      </div>
    </div>
  );
}

function Toolbar(props: {
  provider: PrometheusProvider | ServerProvider;
  /** "Loading ‹range›" or "Retrying" while a request runs; null otherwise. */
  status: string | null;
  /** metrics-server's live text; null under Prometheus. */
  live: string | null;
}) {
  const range = useMetrics((s) => s.range);
  const view = useMetrics((s) => s.view);
  const setRange = useMetrics((s) => s.setRange);
  const setView = useMetrics((s) => s.setView);
  return (
    <div className={styles.toolbar} data-testid="metrics-toolbar">
      {props.provider.kind === "prometheus" ? (
        <Segmented
          label="Range"
          size="sm"
          value={range}
          options={RANGES}
          onChange={setRange}
          testId="metrics-range"
        />
      ) : null}
      {props.live === null ? null : (
        <>
          <span data-testid="metrics-live-badge">
            <Badge tone="ok">
              <span className={styles.liveDot} aria-hidden="true" />
              Live
            </Badge>
          </span>
          <span className={styles.live} data-testid="metrics-live">
            {props.live}
          </span>
        </>
      )}
      <Segmented
        label="View"
        size="sm"
        value={view}
        options={VIEWS}
        onChange={setView}
        testId="metrics-view"
      />
      {props.status === null ? null : (
        <span className={styles.loading} data-testid="metrics-loading">
          <Spinner />
          {props.status}
        </span>
      )}
      <p className={styles.source} data-testid="metrics-source">
        {sourceText(props.provider)}
      </p>
    </div>
  );
}

function ChartGrid(props: {
  layout: "grid" | "column";
  dim: boolean;
  children: ReactNode;
}) {
  const className = [styles[props.layout], props.dim ? styles.dim : null]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={className} data-testid="metrics-grid">
      {props.children}
    </div>
  );
}

interface Drawn {
  main: ChartSeries;
  mirror: ChartSeries | null;
  refs: ChartSeries[];
  missing: string[];
}

/**
 * One chart's series from a Prometheus answer. A metric in `missing` reads "no
 * data" and is never drawn as zero; a missing reference line, or one with no
 * usable point, is left out.
 */
function drawnFrom(def: ChartDef, result: MetricsResult): Drawn {
  const missing: string[] = [];
  const read = (metric: MetricName, name: string): ChartSeries => {
    if (result.missing.includes(metric)) {
      missing.push(name);
      return { name, points: [] };
    }
    return { name, points: usablePoints(result.series[metric]) };
  };
  const main = read(def.main.metric, def.main.name);
  const mirror = def.mirror ? read(def.mirror.metric, def.mirror.name) : null;
  const refs = def.refs
    .filter((r) => !result.missing.includes(r.metric))
    .map((r) => ({
      name: r.name,
      points: usablePoints(result.series[r.metric]),
    }))
    .filter((r) => r.points.length > 0);
  return { main, mirror, refs, missing };
}

function PrometheusMetrics(
  props: MetricsPanelProps & { provider: PrometheusProvider },
) {
  const { clusterId, target, provider } = props;
  const range = useMetrics((s) => s.range);
  const view = useMetrics((s) => s.view);
  const slice = useQueryWatch(clusterId, target, range);
  const result = slice?.value ?? null;
  const error = slice?.error ?? null;
  // Until the watch has made its slice, its first ask is about to run.
  const busy = slice?.loading ?? true;

  // A new range keeps the last range's charts of the same target, dimmed, until
  // its first answer.
  const targetKey = queryKey(clusterId, target, "1h");
  const last = useRef<{
    targetKey: string;
    range: MetricsRange;
    result: MetricsResult;
  } | null>(null);
  if (result) last.current = { targetKey, range, result };
  const kept = last.current;
  const shown = result
    ? { range, result }
    : kept !== null && kept.targetKey === targetKey
      ? kept
      : null;

  const status = busy ? (error ? "Retrying" : `Loading ${range}`) : null;
  return (
    <>
      <Toolbar provider={provider} status={status} live={null} />
      {error ? (
        <ErrorBlock
          clusterId={clusterId}
          title="Prometheus did not answer"
          error={error}
          busy={busy}
          onRetry={() => void askQuery(clusterId, target, range)}
        />
      ) : null}
      {shown ? (
        <ChartGrid layout={props.layout} dim={busy || error !== null}>
          {chartsFor(
            target,
            "prometheus",
            mergeFacts(props.facts, factsFromResult(shown.result)),
          ).map((def) => {
            const drawn = drawnFrom(def, shown.result);
            return (
              <TimeChart
                key={def.stem}
                stem={def.stem}
                title={def.title}
                sub={def.sub}
                unit={def.unit}
                main={drawn.main}
                mirror={drawn.mirror}
                refs={drawn.refs}
                domain={{
                  start: shown.result.start,
                  end: shown.result.end,
                  step: shown.result.step,
                }}
                period={RANGE_PERIOD[shown.range]}
                days={shown.range === "7d"}
                missing={drawn.missing}
                emptyText={
                  props.objectEmpty?.("prometheus", shown.result.start) ??
                  "No samples in this range."
                }
                view={view}
              />
            );
          })}
        </ChartGrid>
      ) : null}
    </>
  );
}

function ServerMetrics(
  props: MetricsPanelProps & { provider: ServerProvider },
) {
  const { clusterId, target, usage, provider } = props;
  const view = useMetrics((s) => s.view);
  const slice = useUsageWatch(
    clusterId,
    usage?.of ?? "nodes",
    usage?.namespace ?? null,
    usage !== null,
  );
  const seconds = useSecondsUntil(slice?.nextAt ?? null);
  if (usage === null) return <Note text={serverNote(target)} />;

  const error = slice?.error ?? null;
  const busy = slice?.loading ?? false;
  const rolling = sumHistory(slice?.history ?? {}, usage.keys);
  // metrics-server is read every 15 s, so only a retry shows a status.
  const toolbar = (
    <Toolbar
      provider={provider}
      status={busy && error ? "Retrying" : null}
      live={liveText(rolling.cpu)}
    />
  );
  if (target.kind === "cluster" && error?.code === "Forbidden") {
    return (
      <>
        {toolbar}
        <Note text={FORBIDDEN_NOTE} />
      </>
    );
  }

  const series: Record<string, Point[]> = {
    cpu: rolling.cpu,
    memory: rolling.memory,
  };
  const domain = rollingDomain(rolling.cpu);
  const period = `${Math.max(1, rollingMinutes(rolling.cpu))} min`;
  const emptyText =
    props.objectEmpty?.("metricsServer", null) ??
    `Collecting samples: metrics-server is read every 15 s, the next sample arrives in ${seconds ?? 15} s.`;
  return (
    <>
      {toolbar}
      <Note text={serverNote(target)} />
      {error ? (
        <ErrorBlock
          clusterId={clusterId}
          title="metrics.k8s.io did not answer"
          error={error}
          busy={busy}
          onRetry={() => void askUsage(clusterId, usage.of, usage.namespace)}
        />
      ) : null}
      <ChartGrid layout={props.layout} dim={error !== null}>
        {chartsFor(target, "metricsServer", props.facts).map((def) => (
          <TimeChart
            key={def.stem}
            stem={def.stem}
            title={def.title}
            sub={def.sub}
            unit={def.unit}
            main={{ name: def.main.name, points: series[def.stem] ?? [] }}
            mirror={null}
            refs={[]}
            domain={domain}
            period={period}
            days={false}
            missing={[]}
            emptyText={emptyText}
            view={view}
          />
        ))}
      </ChartGrid>
    </>
  );
}

/**
 * One target's charts, from whichever provider answers for the cluster, with the
 * toolbar, the notes and the error block of spec §8.
 */
export function MetricsPanel(props: MetricsPanelProps) {
  const { clusterId } = props;
  const provider = useProvider(clusterId);
  const value = provider?.value ?? null;
  const error = provider?.error ?? null;

  let body: ReactNode;
  if (value === null) {
    body = error ? null : <Spinner label="Checking the metrics provider" />;
  } else if (value.kind === "none") {
    body =
      value.chosenBy === "setting" ? (
        <Note
          text="Metrics are off: the metrics provider is None in the cluster settings."
          action={{ label: "Cluster settings", to: settingsPath(clusterId) }}
        />
      ) : (
        <Note
          text={`No metrics provider answers in ${props.clusterName}: there is no Prometheus Service and the metrics.k8s.io API is not served. Install metrics-server or kube-prometheus-stack from the Helm charts.`}
          action={{ label: "Helm charts", to: chartsPath(clusterId) }}
        />
      );
  } else if (value.kind === "prometheus") {
    body = <PrometheusMetrics {...props} provider={value} />;
  } else {
    body = <ServerMetrics {...props} provider={value} />;
  }

  return (
    <div className={styles.panel} data-testid="metrics-panel">
      {error && value === null ? (
        <ErrorBlock
          clusterId={clusterId}
          title="Metrics could not be checked"
          error={error}
          busy={provider?.loading ?? false}
          onRetry={() => void refreshProvider(clusterId)}
        />
      ) : null}
      {body}
    </div>
  );
}
