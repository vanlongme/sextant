import type { UsageSnapshot } from "../../ipc/generated/UsageSnapshot";
import type { KubeObject } from "../../kinds/objects";
import type { MetricsSource } from "./charts";
import { gibibytes, oneDecimal, parseQuantity } from "./format";

/** One Overview gauge: a percentage for `ProgressBar` and its caption. */
export interface Gauge {
  value: number | null;
  caption: string;
}

export const SOURCE_NAME: Record<MetricsSource, string> = {
  prometheus: "Prometheus",
  metricsServer: "metrics-server",
};

/**
 * Usage against allocatable. Without a usable usage or allocatable the gauge has
 * no value and reads "No data".
 */
export function gauge(
  used: number | null,
  allocatable: number | null,
  unit: "cores" | "bytes",
  source: string,
): Gauge {
  if (
    used === null ||
    allocatable === null ||
    !Number.isFinite(used) ||
    !Number.isFinite(allocatable) ||
    used < 0 ||
    allocatable <= 0
  ) {
    return { value: null, caption: "No data" };
  }
  const caption =
    unit === "cores"
      ? `${oneDecimal(used)} of ${oneDecimal(allocatable)} cores · ${source}`
      : `${gibibytes(used)} of ${gibibytes(allocatable)} GiB · ${source}`;
  return { value: (used / allocatable) * 100, caption };
}

/** The sum of the nodes' `status.allocatable`; null when no node has a value. */
export function nodeAllocatable(nodes: KubeObject[]): {
  cores: number | null;
  bytes: number | null;
} {
  let cores: number | null = null;
  let bytes: number | null = null;
  for (const node of nodes) {
    const cpu = parseQuantity(node.status?.allocatable?.cpu);
    const memory = parseQuantity(node.status?.allocatable?.memory);
    if (cpu !== null) cores = (cores ?? 0) + cpu;
    if (memory !== null) bytes = (bytes ?? 0) + memory;
  }
  return { cores, bytes };
}

/** The sum of a metrics-server snapshot; null without a snapshot or with no item. */
export function snapshotTotals(snapshot: UsageSnapshot | null): {
  cores: number | null;
  bytes: number | null;
} {
  if (snapshot === null || snapshot.items.length === 0) {
    return { cores: null, bytes: null };
  }
  let cores = 0;
  let bytes = 0;
  for (const item of snapshot.items) {
    cores += item.cpuCores;
    bytes += item.memoryBytes;
  }
  return { cores, bytes };
}
