import { create, type StoreApi, type UseBoundStore } from "zustand";
import { api } from "../ipc/api";
import type { IpcFailure } from "../ipc/client";
import type { MetricsProvider } from "../ipc/generated/MetricsProvider";
import type { MetricsRange } from "../ipc/generated/MetricsRange";
import type { MetricsResult } from "../ipc/generated/MetricsResult";
import type { MetricsTarget } from "../ipc/generated/MetricsTarget";
import type { UsageItem } from "../ipc/generated/UsageItem";
import type { UsageOf } from "../ipc/generated/UsageOf";
import type { UsageSnapshot } from "../ipc/generated/UsageSnapshot";
import { useCatalog } from "./catalog";
import { asFailure } from "./helm";

/** One thing the store reads: the last good value, the last failure, a call in flight. */
export interface Slice<T> {
  value: T | null;
  error: IpcFailure | null;
  loading: boolean;
}

export type MetricsView = "chart" | "table";

/** One metrics-server sample of one item: unix seconds, cores, bytes. */
export interface Sample {
  t: number;
  cpu: number;
  memory: number;
}

export interface UsageSlice extends Slice<UsageSnapshot> {
  /** Rolling samples per item: `namespace/name` for Pods, the name for nodes. */
  history: Record<string, Sample[]>;
  /** When the next ask is due, in ms since the epoch; null while no poller runs. */
  nextAt: number | null;
}

/** How often a Prometheus query asks again: one step of its range (spec §5.2). */
export const QUERY_STEP_MS: Record<MetricsRange, number> = {
  "1h": 60_000,
  "6h": 300_000,
  "24h": 900_000,
  "7d": 3_600_000,
};

/** metrics-server is read every 15 s. */
export const USAGE_POLL_MS = 15_000;
/** One hour of 15 s samples per item. */
export const HISTORY_LIMIT = 240;
export const HISTORY_SECONDS = 3600;

export interface MetricsState {
  /** By cluster id. */
  providers: Record<string, Slice<MetricsProvider>>;
  /** By `queryKey`. */
  queries: Record<string, Slice<MetricsResult>>;
  /** By `usageKey`. */
  usage: Record<string, UsageSlice>;
  /** By cluster id: metrics.k8s.io answered that it is not served. */
  usageNotServed: Record<string, boolean>;
  /** Shared by every panel, kept in memory only. */
  range: MetricsRange;
  view: MetricsView;
  setRange(range: MetricsRange): void;
  setView(view: MetricsView): void;
}

const FIRST = {
  providers: {},
  queries: {},
  usage: {},
  usageNotServed: {},
  range: "1h",
  view: "chart",
} satisfies Partial<MetricsState>;

export const useMetrics: UseBoundStore<StoreApi<MetricsState>> =
  create<MetricsState>((set) => ({
    ...FIRST,
    setRange: (range) => set({ range }),
    setView: (view) => set({ view }),
  }));

const IDLE = { value: null, error: null, loading: false } as const;
const IDLE_USAGE: UsageSlice = { ...IDLE, history: {}, nextAt: null };

interface Poller {
  key: string;
  clusterId: string;
  /** A metrics-server poller: it records `nextAt` and pauses while usage is not served. */
  usage: boolean;
  /** Watchers that share it. */
  count: number;
  timer: number;
  /** A tick came while the window was hidden or the cluster was not connected. */
  missed: boolean;
  ask(): void;
}

const pollers = new Map<string, Poller>();
// Each ask of a key takes the next number; only the newest one's answer is kept.
const seqs = new Map<string, number>();
const providerSeq = new Map<string, number>();
const providerLoads = new Map<string, Promise<void>>();
// Clusters whose provider was read again after a noMetricsServer answer, until forgetProvider.
const notServedRefreshed = new Set<string>();
let unwatchCatalog: (() => void) | null = null;

/** The same string for the same cluster, target and range, whatever order the target's fields were written in. */
export function queryKey(
  clusterId: string,
  target: MetricsTarget,
  range: MetricsRange,
): string {
  return JSON.stringify([
    clusterId,
    target.kind,
    "namespace" in target ? target.namespace : null,
    "name" in target ? target.name : null,
    "workloadKind" in target ? target.workloadKind : null,
    range,
  ]);
}

function nextSeq(key: string): number {
  const mine = (seqs.get(key) ?? 0) + 1;
  seqs.set(key, mine);
  return mine;
}

function connected(clusterId: string): boolean {
  return (
    useCatalog.getState().clusters.find((c) => c.id === clusterId)?.state
      .status === "connected"
  );
}

function mayAsk(poller: Poller): boolean {
  return (
    document.visibilityState === "visible" &&
    connected(poller.clusterId) &&
    !(poller.usage && useMetrics.getState().usageNotServed[poller.clusterId])
  );
}

function tick(poller: Poller): void {
  if (poller.usage) {
    patchUsage(poller.key, { nextAt: Date.now() + USAGE_POLL_MS });
  }
  if (mayAsk(poller)) {
    poller.missed = false;
    poller.ask();
  } else {
    poller.missed = true;
  }
}

function markMissed(key: string): void {
  const poller = pollers.get(key);
  if (poller) poller.missed = true;
}

/** Every poller of the cluster that missed a tick asks now, if it may. */
function askMissed(clusterId: string): void {
  for (const poller of pollers.values()) {
    if (poller.clusterId === clusterId && poller.missed) tick(poller);
  }
}

function onVisibility(): void {
  if (document.visibilityState !== "visible") return;
  for (const poller of pollers.values()) {
    if (poller.missed) tick(poller);
  }
}

function statusesOf(): Map<string, string> {
  return new Map(
    useCatalog.getState().clusters.map((c) => [c.id, c.state.status] as const),
  );
}

/**
 * Reconnects are watched for the store's whole life, not only while a poller lives:
 * a disconnected cluster unmounts every panel, and the provider must still be forgotten.
 */
function watchCatalog(): void {
  if (unwatchCatalog) return;
  let statuses = statusesOf();
  unwatchCatalog = useCatalog.subscribe(() => {
    const before = statuses;
    statuses = statusesOf();
    for (const [clusterId, status] of statuses) {
      if (status === "connected" && before.get(clusterId) !== "connected") {
        // A new connection may reach another provider; forgetProvider also asks the missed pollers.
        forgetProvider(clusterId);
      }
    }
  });
}

/** Starts with the first poller: the window coming back. */
function startListening(): void {
  document.addEventListener("visibilitychange", onVisibility);
}

function stopListening(): void {
  document.removeEventListener("visibilitychange", onVisibility);
}

/** Ref counts one poller per key; the poller asks at once and then every `every` ms. */
function watch(
  key: string,
  clusterId: string,
  usage: boolean,
  every: number,
  ask: () => void,
): () => void {
  let poller = pollers.get(key);
  if (!poller) {
    watchCatalog();
    if (pollers.size === 0) startListening();
    const created: Poller = {
      key,
      clusterId,
      usage,
      count: 0,
      timer: 0,
      missed: false,
      ask,
    };
    created.timer = window.setInterval(() => tick(created), every);
    pollers.set(key, created);
    tick(created);
    poller = created;
  }
  poller.count += 1;
  const mine = poller;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    mine.count -= 1;
    if (mine.count > 0) return;
    window.clearInterval(mine.timer);
    pollers.delete(key);
    if (mine.usage) patchUsage(key, { nextAt: null });
    if (pollers.size === 0) stopListening();
  };
}

function patchProvider(
  clusterId: string,
  change: Partial<Slice<MetricsProvider>>,
): void {
  useMetrics.setState((s) => ({
    providers: {
      ...s.providers,
      [clusterId]: { ...(s.providers[clusterId] ?? IDLE), ...change },
    },
  }));
}

function patchQuery(key: string, change: Partial<Slice<MetricsResult>>): void {
  useMetrics.setState((s) => ({
    queries: {
      ...s.queries,
      [key]: { ...(s.queries[key] ?? IDLE), ...change },
    },
  }));
}

function patchUsage(key: string, change: Partial<UsageSlice>): void {
  useMetrics.setState((s) => ({
    usage: {
      ...s.usage,
      [key]: { ...(s.usage[key] ?? IDLE_USAGE), ...change },
    },
  }));
}

function loadProvider(clusterId: string, refresh: boolean): Promise<void> {
  watchCatalog();
  const mine = (providerSeq.get(clusterId) ?? 0) + 1;
  providerSeq.set(clusterId, mine);
  patchProvider(clusterId, { loading: true });
  const read = (async () => {
    try {
      const value = await api.metricsProvider(clusterId, refresh);
      if (providerSeq.get(clusterId) !== mine) return;
      patchProvider(clusterId, { value, error: null, loading: false });
      if (useMetrics.getState().usageNotServed[clusterId]) {
        // Looked again after a noMetricsServer answer: let the usage pollers try again.
        useMetrics.setState((s) => {
          const usageNotServed = { ...s.usageNotServed };
          delete usageNotServed[clusterId];
          return { usageNotServed };
        });
        for (const poller of pollers.values()) {
          if (poller.usage && poller.clusterId === clusterId) tick(poller);
        }
      }
    } catch (error) {
      if (providerSeq.get(clusterId) !== mine) return;
      patchProvider(clusterId, { error: asFailure(error), loading: false });
    } finally {
      if (providerSeq.get(clusterId) === mine) providerLoads.delete(clusterId);
    }
  })();
  providerLoads.set(clusterId, read);
  return read;
}

/** Reads the cluster's provider once; a cached or loading one is left alone. */
export function ensureProvider(clusterId: string): void {
  if (useMetrics.getState().providers[clusterId]) return;
  if (providerLoads.has(clusterId)) return;
  void loadProvider(clusterId, false);
}

/** Looks for the provider again. One read runs at a time per cluster; the shown provider stays until it answers. */
export function refreshProvider(clusterId: string): Promise<void> {
  return providerLoads.get(clusterId) ?? loadProvider(clusterId, true);
}

/**
 * Drops the cached provider, after a save of the settings and on a reconnect,
 * so the next `ensureProvider` reads it again. A read still on its way is ignored.
 */
export function forgetProvider(clusterId: string): void {
  providerSeq.set(clusterId, (providerSeq.get(clusterId) ?? 0) + 1);
  providerLoads.delete(clusterId);
  notServedRefreshed.delete(clusterId);
  useMetrics.setState((s) => {
    const providers = { ...s.providers };
    delete providers[clusterId];
    const usageNotServed = { ...s.usageNotServed };
    delete usageNotServed[clusterId];
    return { providers, usageNotServed };
  });
  askMissed(clusterId);
}

/** Asks Prometheus now, whatever the poller's state (the error block's Retry). */
export async function askQuery(
  clusterId: string,
  target: MetricsTarget,
  range: MetricsRange,
): Promise<void> {
  const key = queryKey(clusterId, target, range);
  const mine = nextSeq(key);
  patchQuery(key, { loading: true });
  try {
    const value = await api.metricsQuery(clusterId, target, range);
    if (seqs.get(key) !== mine) return;
    patchQuery(key, { value, error: null, loading: false });
  } catch (error) {
    if (seqs.get(key) !== mine) return;
    const failure = asFailure(error);
    if (failure.code === "Unreachable") {
      // The cluster went away: no error block, and the poller asks on the reconnect.
      patchQuery(key, { loading: false });
      markMissed(key);
    } else if (
      failure.code === "NotFound" &&
      failure.details === "noPrometheus"
    ) {
      // The provider changed under us: render for the new one.
      patchQuery(key, { loading: false });
      void refreshProvider(clusterId);
    } else {
      patchQuery(key, { error: failure, loading: false });
    }
  }
}

/**
 * Keeps a Prometheus query fresh while something shows it: watchers of the same
 * cluster, target and range share one poller that asks at once, then once per step.
 */
export function watchQuery(
  clusterId: string,
  target: MetricsTarget,
  range: MetricsRange,
): () => void {
  return watch(
    queryKey(clusterId, target, range),
    clusterId,
    false,
    QUERY_STEP_MS[range],
    () => {
      void askQuery(clusterId, target, range);
    },
  );
}

export function usageKey(
  clusterId: string,
  of: UsageOf,
  namespace: string | null,
): string {
  return JSON.stringify([clusterId, of, namespace]);
}

function itemKey(of: UsageOf, item: UsageItem): string {
  return of === "nodes" ? item.name : `${item.namespace ?? ""}/${item.name}`;
}

/**
 * Appends a snapshot to the rolling history: one sample per item, only when it is
 * newer than the item's last one. Samples an hour older than the snapshot go, also
 * for items that left it, and each item keeps its newest `HISTORY_LIMIT`.
 */
function appendHistory(
  history: Record<string, Sample[]>,
  snapshot: UsageSnapshot,
  of: UsageOf,
): Record<string, Sample[]> {
  const t = Date.parse(snapshot.timestamp) / 1000;
  if (!Number.isFinite(t)) return history;
  const next: Record<string, Sample[]> = { ...history };
  for (const item of snapshot.items) {
    const key = itemKey(of, item);
    const samples = next[key] ?? [];
    const last = samples[samples.length - 1];
    if (last && last.t >= t) continue;
    next[key] = [
      ...samples,
      { t, cpu: item.cpuCores, memory: item.memoryBytes },
    ];
  }
  for (const [key, samples] of Object.entries(next)) {
    const kept = samples
      .filter((sample) => sample.t > t - HISTORY_SECONDS)
      .slice(-HISTORY_LIMIT);
    if (kept.length === 0) delete next[key];
    else next[key] = kept;
  }
  return next;
}

/** metrics.k8s.io is not served: the cluster's usage pollers pause until the provider is read again. */
function markNotServed(clusterId: string): void {
  useMetrics.setState((s) => ({
    usageNotServed: { ...s.usageNotServed, [clusterId]: true },
  }));
  const provider = useMetrics.getState().providers[clusterId]?.value;
  if (
    provider?.kind === "metricsServer" &&
    !notServedRefreshed.has(clusterId)
  ) {
    notServedRefreshed.add(clusterId);
    void refreshProvider(clusterId);
  }
}

/** Reads metrics.k8s.io now, whatever the poller's state (the error block's Retry). */
export async function askUsage(
  clusterId: string,
  of: UsageOf,
  namespace: string | null,
): Promise<void> {
  const key = usageKey(clusterId, of, namespace);
  const mine = nextSeq(key);
  patchUsage(key, { loading: true });
  try {
    const snapshot = await api.metricsUsage(clusterId, of, namespace);
    if (seqs.get(key) !== mine) return;
    useMetrics.setState((s) => {
      const slice = s.usage[key] ?? IDLE_USAGE;
      return {
        usage: {
          ...s.usage,
          [key]: {
            ...slice,
            value: snapshot,
            error: null,
            loading: false,
            history: appendHistory(slice.history, snapshot, of),
          },
        },
      };
    });
  } catch (error) {
    if (seqs.get(key) !== mine) return;
    const failure = asFailure(error);
    if (failure.code === "Unreachable") {
      patchUsage(key, { loading: false });
      markMissed(key);
    } else if (
      failure.code === "NotFound" &&
      failure.details === "noMetricsServer"
    ) {
      patchUsage(key, { loading: false });
      markNotServed(clusterId);
    } else {
      patchUsage(key, { error: failure, loading: false });
    }
  }
}

/**
 * Keeps metrics.k8s.io usage fresh while something shows it: watchers of the same
 * cluster, `of` and namespace share one poller that asks at once, then every 15 s.
 */
export function watchUsage(
  clusterId: string,
  of: UsageOf,
  namespace: string | null,
): () => void {
  return watch(
    usageKey(clusterId, of, namespace),
    clusterId,
    true,
    USAGE_POLL_MS,
    () => {
      void askUsage(clusterId, of, namespace);
    },
  );
}

export function resetMetricsForTest(): void {
  for (const poller of pollers.values()) window.clearInterval(poller.timer);
  pollers.clear();
  seqs.clear();
  providerSeq.clear();
  providerLoads.clear();
  notServedRefreshed.clear();
  stopListening();
  unwatchCatalog?.();
  unwatchCatalog = null;
  useMetrics.setState(FIRST);
}
