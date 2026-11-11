import { useEffect, useMemo, useRef, useState } from "react";
import type { MetricsProvider } from "../../ipc/generated/MetricsProvider";
import type { MetricsRange } from "../../ipc/generated/MetricsRange";
import type { MetricsResult } from "../../ipc/generated/MetricsResult";
import type { MetricsTarget } from "../../ipc/generated/MetricsTarget";
import type { UsageOf } from "../../ipc/generated/UsageOf";
import {
  ensureProvider,
  queryKey,
  type Slice,
  type UsageSlice,
  usageKey,
  useMetrics,
  watchQuery,
  watchUsage,
} from "../../stores/metrics";

/**
 * The cluster's metrics provider. It is loaded once and shared; after
 * `forgetProvider` the slice is gone, so the next render loads it again.
 */
export function useProvider(
  clusterId: string,
): Slice<MetricsProvider> | undefined {
  const slice = useMetrics((s) => s.providers[clusterId]);
  useEffect(() => {
    if (slice === undefined) ensureProvider(clusterId);
  }, [clusterId, slice]);
  return slice;
}

/**
 * Watches one Prometheus query while `target` is set. The watch follows the
 * query's key, so a new target object for the same target does not ask again.
 */
export function useQueryWatch(
  clusterId: string,
  target: MetricsTarget | null,
  range: MetricsRange,
): Slice<MetricsResult> | undefined {
  const key = target === null ? null : queryKey(clusterId, target, range);
  // The effect depends on the key; it reads the target object from a ref.
  const latest = useRef(target);
  latest.current = target;
  useEffect(() => {
    const wanted = latest.current;
    if (key === null || wanted === null) return;
    return watchQuery(clusterId, wanted, range);
  }, [key, clusterId, range]);
  return useMetrics((s) => (key === null ? undefined : s.queries[key]));
}

/** Watches one metrics-server snapshot while `enabled`. */
export function useUsageWatch(
  clusterId: string,
  of: UsageOf,
  namespace: string | null,
  enabled: boolean,
): UsageSlice | undefined {
  const key = enabled ? usageKey(clusterId, of, namespace) : null;
  useEffect(() => {
    if (!enabled) return;
    return watchUsage(clusterId, of, namespace);
  }, [enabled, clusterId, of, namespace]);
  return useMetrics((s) => (key === null ? undefined : s.usage[key]));
}

/**
 * Watches one snapshot per namespace while `enabled`, and returns their slices in
 * the order given; a slice not created yet is left out.
 */
export function useUsageWatches(
  clusterId: string,
  of: UsageOf,
  namespaces: (string | null)[],
  enabled: boolean,
): UsageSlice[] {
  const joined = enabled
    ? namespaces.map((ns) => usageKey(clusterId, of, ns)).join("\n")
    : "";
  // The effect depends on the joined keys; it reads the namespaces from a ref.
  const latest = useRef(namespaces);
  latest.current = namespaces;
  useEffect(() => {
    if (joined === "") return;
    const stops = latest.current.map((ns) => watchUsage(clusterId, of, ns));
    return () => {
      for (const stop of stops) stop();
    };
  }, [joined, clusterId, of]);
  const usage = useMetrics((s) => s.usage);
  return useMemo(() => {
    if (joined === "") return [];
    return joined.split("\n").flatMap((key) => {
      const slice = usage[key];
      return slice ? [slice] : [];
    });
  }, [joined, usage]);
}

/**
 * Whole seconds until `at` (ms since the epoch), never below 0, updated every
 * second; null while `at` is null.
 */
export function useSecondsUntil(at: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (at === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [at]);
  if (at === null) return null;
  return Math.max(0, Math.ceil((at - now) / 1000));
}
