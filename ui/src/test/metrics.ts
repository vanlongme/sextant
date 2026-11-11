import type { ClusterSettings } from "../ipc/generated/ClusterSettings";
import type { IpcError } from "../ipc/generated/IpcError";
import type { MetricsProvider } from "../ipc/generated/MetricsProvider";
import type { MetricsResult } from "../ipc/generated/MetricsResult";
import type { PrometheusChoice } from "../ipc/generated/PrometheusChoice";
import type { UsageItem } from "../ipc/generated/UsageItem";
import type { UsageSnapshot } from "../ipc/generated/UsageSnapshot";

/** 2026-11-11T10:00:00Z: the first sample of every fixture series. */
export const T0 = 1_794_391_200;

export const NO_PROMETHEUS: IpcError = {
  code: "NotFound",
  message: "No Prometheus answers for this cluster",
  details: "noPrometheus",
};
export const NO_METRICS_SERVER: IpcError = {
  code: "NotFound",
  message: "metrics.k8s.io is not served",
  details: "noMetricsServer",
};
export const UNREACHABLE: IpcError = {
  code: "Unreachable",
  message: "The cluster is not connected",
  details: null,
};
export const FORBIDDEN: IpcError = {
  code: "Forbidden",
  message: "nodes.metrics.k8s.io is forbidden",
  details: null,
};
export const PROMETHEUS_DOWN: IpcError = {
  code: "Internal",
  message: "Prometheus answered 503",
  details: null,
};

export function prometheus(
  over: {
    namespace?: string;
    service?: string;
    port?: number;
    chosenBy?: PrometheusChoice;
  } = {},
): MetricsProvider {
  return {
    kind: "prometheus",
    namespace: "monitoring",
    service: "prometheus-server",
    port: 80,
    chosenBy: "communityChart",
    ...over,
  };
}

export function metricsServer(
  chosenBy: "setting" | "fallback" = "fallback",
): MetricsProvider {
  return { kind: "metricsServer", chosenBy };
}

export function noProvider(
  chosenBy: "setting" | "nothingFound" = "nothingFound",
): MetricsProvider {
  return { kind: "none", chosenBy };
}

/** Samples one `step` apart from `start`; a null leaves that sample out, which makes a gap. */
export function points(
  values: (number | null)[],
  start = T0,
  step = 60,
): [number, number][] {
  const out: [number, number][] = [];
  for (const [i, v] of values.entries()) {
    if (v !== null) out.push([start + i * step, v]);
  }
  return out;
}

export function metricsResult(
  series: MetricsResult["series"],
  over: Partial<MetricsResult> = {},
): MetricsResult {
  return { start: T0, end: T0 + 3600, step: 60, series, missing: [], ...over };
}

export function usageItem(
  over: Partial<UsageItem> & { name: string },
): UsageItem {
  return {
    namespace: "shop",
    cpuCores: 0.25,
    memoryBytes: 64 * 2 ** 20,
    ...over,
  };
}

export function usageSnapshot(items: UsageItem[], at = T0): UsageSnapshot {
  return { timestamp: new Date(at * 1000).toISOString(), items };
}

export function clusterSettings(
  over: Partial<ClusterSettings> = {},
): ClusterSettings {
  return {
    displayName: null,
    icon: null,
    defaultNamespace: null,
    accessibleNamespaces: [],
    terminalCwd: null,
    proxyUrl: null,
    nodeShellImage: null,
    metricsProvider: { kind: "auto" },
    ...over,
  };
}
