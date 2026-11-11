import type { KubeObject } from "../../kinds/objects";
import { type LabelSelector, matchesSelector } from "../../kinds/selectors";
import type { Sample } from "../../stores/metrics";
import { plural } from "./charts";

/** A rolling chart's two series, summed over the items it covers. */
export interface RollingSeries {
  cpu: [number, number][];
  memory: [number, number][];
}

/**
 * Sums the history of `keys` (every item when null) per timestamp, oldest first.
 * The items of one snapshot share its timestamp, so their samples line up.
 */
export function sumHistory(
  history: Record<string, Sample[]>,
  keys: string[] | null,
): RollingSeries {
  const totals = new Map<number, { cpu: number; memory: number }>();
  for (const key of new Set(keys ?? Object.keys(history))) {
    for (const sample of history[key] ?? []) {
      const total = totals.get(sample.t) ?? { cpu: 0, memory: 0 };
      total.cpu += sample.cpu;
      total.memory += sample.memory;
      totals.set(sample.t, total);
    }
  }
  const series: RollingSeries = { cpu: [], memory: [] };
  for (const t of [...totals.keys()].sort((a, b) => a - b)) {
    const total = totals.get(t) ?? { cpu: 0, memory: 0 };
    series.cpu.push([t, total.cpu]);
    series.memory.push([t, total.memory]);
  }
  return series;
}

/** The minutes the samples span, at least 1; 0 with no sample. */
export function rollingMinutes(series: [number, number][]): number {
  const first = series[0];
  const last = series[series.length - 1];
  if (!first || !last) return 0;
  return Math.max(1, Math.ceil((last[0] - first[0]) / 60));
}

/** The time axis of a rolling chart: the samples, and at least the last minute. */
export function rollingDomain(series: [number, number][]): {
  start: number;
  end: number;
  step: number;
} {
  const first = series[0];
  const last = series[series.length - 1];
  if (!first || !last) return { start: 0, end: 60, step: 15 };
  return { start: Math.min(first[0], last[0] - 60), end: last[0], step: 15 };
}

/** The toolbar's text under metrics-server (spec §8.1). */
export function liveText(series: [number, number][]): string {
  if (series.length === 0) return "Waiting for the first sample";
  return `Last ${rollingMinutes(series)} min, ${plural(series.length, "sample", "samples")}`;
}

/**
 * A workload's Pods: those in its namespace whose labels match its `spec.selector`.
 * A missing selector, or one that selects on nothing, matches no Pod.
 */
export function workloadPods(
  workload: KubeObject,
  pods: KubeObject[],
): KubeObject[] {
  const selector = workload.spec?.selector as LabelSelector | undefined;
  if (!selector) return [];
  const labels = Object.keys(selector.matchLabels ?? {}).length;
  const expressions = (selector.matchExpressions ?? []).length;
  if (labels === 0 && expressions === 0) return [];
  const namespace = workload.metadata.namespace;
  return pods.filter(
    (pod) =>
      pod.metadata.namespace === namespace &&
      matchesSelector(pod.metadata.labels, selector),
  );
}
