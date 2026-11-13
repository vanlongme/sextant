import { useCallback, useEffect, useRef } from "react";
import { create } from "zustand";
import { api } from "../ipc/api";
import { failureMessage } from "../ipc/client";
import type { GraphEvent } from "../ipc/generated/GraphEvent";

export type GraphSnapshot = Extract<GraphEvent, { type: "snapshot" }>;

/** One cluster and namespace filter's graph (spec E §6.2). */
export interface GraphEntry {
  /** The last snapshot. A failure keeps it, and so does a retry until the next one. */
  snapshot: GraphSnapshot | null;
  error: string | null;
  loading: boolean;
}

/** The sorted namespaces joined by commas, or `*` for every namespace. */
export function filterKey(namespaces: readonly string[] | null): string {
  return namespaces === null ? "*" : [...namespaces].sort().join(",");
}

/** The store key of a cluster and namespace filter. */
export function graphKey(
  clusterId: string,
  namespaces: readonly string[] | null,
): string {
  return JSON.stringify([clusterId, filterKey(namespaces)]);
}

interface GraphState {
  entries: Record<string, GraphEntry>;
}

export const useGraphStore = create<GraphState>(() => ({ entries: {} }));

const LOADING: GraphEntry = { snapshot: null, error: null, loading: true };
const IDLE: GraphEntry = { snapshot: null, error: null, loading: false };

/** One backend subscription, shared by every watcher of the same key. */
interface Watch {
  clusterId: string;
  namespaces: string[] | null;
  count: number;
  /** Bumped by each subscribe and by the end, so late events and ids are dropped. */
  generation: number;
  /** Set once the backend answered, and cleared when the subscription ends. */
  subscriptionId: string | null;
}

const watches = new Map<string, Watch>();

function patch(key: string, change: Partial<GraphEntry>): void {
  useGraphStore.setState((s) => ({
    entries: {
      ...s.entries,
      [key]: { ...(s.entries[key] ?? LOADING), ...change },
    },
  }));
}

function endSubscription(watch: Watch): void {
  const id = watch.subscriptionId;
  watch.subscriptionId = null;
  if (id !== null) void api.resourceGraphUnsubscribe(id).catch(() => {});
}

function subscribe(key: string, watch: Watch): void {
  watch.generation += 1;
  const mine = watch.generation;
  const current = () => watches.get(key) === watch && watch.generation === mine;
  // A failure ends the subscription on the backend, so there is nothing to end here.
  let failed = false;
  patch(key, { error: null, loading: true });
  api
    .resourceGraphSubscribe(watch.clusterId, watch.namespaces, (event) => {
      if (!current()) return;
      if (event.type === "snapshot") {
        patch(key, { snapshot: event, error: null, loading: false });
      } else {
        failed = true;
        watch.subscriptionId = null;
        patch(key, { error: event.message, loading: false });
      }
    })
    .then(
      (id) => {
        if (!current()) {
          void api.resourceGraphUnsubscribe(id).catch(() => {});
        } else if (!failed) {
          watch.subscriptionId = id;
        }
      },
      (error) => {
        if (current()) {
          patch(key, { error: failureMessage(error), loading: false });
        }
      },
    );
}

/**
 * Watches a cluster's graph for a namespace filter (null: every namespace). The first
 * watcher of a key subscribes and the last one to leave unsubscribes and drops the
 * entry. Returns the function that leaves; calling it again does nothing.
 */
export function watchGraph(
  clusterId: string,
  namespaces: readonly string[] | null,
): () => void {
  const key = graphKey(clusterId, namespaces);
  let watch = watches.get(key);
  if (!watch) {
    watch = {
      clusterId,
      namespaces: namespaces === null ? null : [...namespaces].sort(),
      count: 0,
      generation: 0,
      subscriptionId: null,
    };
    watches.set(key, watch);
    subscribe(key, watch);
  }
  watch.count += 1;
  const mine = watch;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    mine.count -= 1;
    if (mine.count > 0) return;
    if (watches.get(key) === mine) watches.delete(key);
    mine.generation += 1;
    endSubscription(mine);
    useGraphStore.setState((s) => {
      const entries = { ...s.entries };
      delete entries[key];
      return { entries };
    });
  };
}

/** Subscribes a watched key again, after a failure or a refused subscribe. */
export function retryGraph(
  clusterId: string,
  namespaces: readonly string[] | null,
): void {
  const key = graphKey(clusterId, namespaces);
  const watch = watches.get(key);
  if (!watch) return;
  endSubscription(watch);
  subscribe(key, watch);
}

/**
 * The graph of a cluster and namespace filter for a component, watched while it is
 * mounted; `retry` subscribes again. A null cluster watches nothing.
 */
export function useGraph(
  clusterId: string | null,
  namespaces: readonly string[] | null,
): GraphEntry & { retry(): void } {
  const key = clusterId === null ? null : graphKey(clusterId, namespaces);
  // The effect depends on the key, so it reads the latest props from a ref.
  const latest = useRef({ clusterId, namespaces });
  latest.current = { clusterId, namespaces };

  useEffect(() => {
    const { clusterId: cluster, namespaces: filter } = latest.current;
    if (key === null || cluster === null) return;
    return watchGraph(cluster, filter);
  }, [key]);

  const entry = useGraphStore((s) =>
    key === null ? undefined : s.entries[key],
  );
  const retry = useCallback(() => {
    const { clusterId: cluster, namespaces: filter } = latest.current;
    if (cluster !== null) retryGraph(cluster, filter);
  }, []);
  return { ...(entry ?? (key === null ? IDLE : LOADING)), retry };
}

export function resetGraphForTest(): void {
  for (const watch of watches.values()) watch.generation += 1;
  watches.clear();
  useGraphStore.setState({ entries: {} });
}
