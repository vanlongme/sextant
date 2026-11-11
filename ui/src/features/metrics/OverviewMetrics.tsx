import { ProgressBar } from "../../design";
import type { ClusterInfo } from "../../ipc/generated/ClusterInfo";
import type { MetricsTarget } from "../../ipc/generated/MetricsTarget";
import { NODES } from "../../kinds/refs";
import { useMetrics } from "../../stores/metrics";
import { useResourceList } from "../../stores/resources";
import { lastValue, NO_FACTS, type TargetFacts } from "./charts";
import {
  type Gauge,
  gauge,
  nodeAllocatable,
  SOURCE_NAME,
  snapshotTotals,
} from "./gauges";
import { useProvider, useQueryWatch, useUsageWatch } from "./hooks";
import { MetricsPanel, type UsageSource } from "./MetricsPanel";
import styles from "./OverviewMetrics.module.css";

const CLUSTER: MetricsTarget = { kind: "cluster" };
const NODE_USAGE: UsageSource = { of: "nodes", namespace: null, keys: null };

function GaugeRow(props: {
  id: "cpu" | "memory";
  label: string;
  gauge: Gauge;
}) {
  return (
    <div className={styles.gauge}>
      <span className={styles.gaugeLabel}>{props.label}</span>
      <ProgressBar
        label={props.label}
        value={props.gauge.value}
        testId={`overview-gauge-${props.id}`}
      />
      <p
        className={styles.caption}
        data-testid={`overview-gauge-${props.id}-caption`}
      >
        {props.gauge.caption}
      </p>
    </div>
  );
}

/**
 * The Overview's CPU and Memory gauges and its Metrics section. Under Prometheus
 * the gauges read the cluster query the panel watches too, so one poller serves
 * both; under metrics-server they sum the node snapshot against the Node watch.
 */
export function OverviewMetrics(props: {
  clusterId: string;
  clusterName: string;
  info: ClusterInfo;
}) {
  const { clusterId, info } = props;
  const kind = useProvider(clusterId)?.value?.kind ?? null;
  const range = useMetrics((s) => s.range);
  const query = useQueryWatch(
    clusterId,
    kind === "prometheus" ? CLUSTER : null,
    range,
  );
  const usage = useUsageWatch(
    clusterId,
    "nodes",
    null,
    kind === "metricsServer",
  );
  const nodes = useResourceList(
    clusterId,
    kind === "metricsServer" ? NODES : null,
  );

  let gauges: { cpu: Gauge; memory: Gauge } | null = null;
  let facts: TargetFacts = { ...NO_FACTS, nodeCount: info.nodeCount };
  if (kind === "prometheus") {
    const series = query?.value?.series;
    const source = SOURCE_NAME.prometheus;
    gauges = {
      cpu: gauge(
        lastValue(series?.cpuUsage),
        lastValue(series?.cpuAllocatable),
        "cores",
        source,
      ),
      memory: gauge(
        lastValue(series?.memoryUsage),
        lastValue(series?.memoryAllocatable),
        "bytes",
        source,
      ),
    };
  } else if (kind === "metricsServer") {
    const used = snapshotTotals(usage?.value ?? null);
    const allocatable = nodeAllocatable(nodes.items);
    const source = SOURCE_NAME.metricsServer;
    gauges = {
      cpu: gauge(used.cores, allocatable.cores, "cores", source),
      memory: gauge(used.bytes, allocatable.bytes, "bytes", source),
    };
    facts = {
      ...facts,
      allocatableCores: allocatable.cores,
      allocatableBytes: allocatable.bytes,
    };
  }

  return (
    <>
      {gauges ? (
        <div className={styles.gauges} data-testid="overview-gauges">
          <GaugeRow id="cpu" label="CPU" gauge={gauges.cpu} />
          <GaugeRow id="memory" label="Memory" gauge={gauges.memory} />
        </div>
      ) : null}
      <section className={styles.metrics} data-testid="overview-metrics">
        <h2 className={styles.heading}>Metrics</h2>
        <MetricsPanel
          clusterId={clusterId}
          clusterName={props.clusterName}
          target={CLUSTER}
          facts={facts}
          usage={NODE_USAGE}
          layout="grid"
        />
      </section>
    </>
  );
}
