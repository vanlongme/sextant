import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { api } from "../ipc/api";
import { failureMessage } from "../ipc/client";
import type { ApiResourceInfo } from "../ipc/generated/ApiResourceInfo";
import type { ObjectKey } from "../ipc/generated/ObjectKey";
import type { ResourceRef } from "../ipc/generated/ResourceRef";
import type { WatchEvent } from "../ipc/generated/WatchEvent";
import type { WatchStatus } from "../ipc/generated/WatchStatus";
import { type KubeObject, objectKey } from "../kinds/objects";

export interface ResourceListState {
  items: KubeObject[];
  status: WatchStatus;
  message: string | null;
  loading: boolean;
}

const IDLE: ResourceListState = {
  items: [],
  status: "syncing",
  message: null,
  loading: false,
};

/** One backend subscription, shared by every component showing the same list. */
interface Entry {
  rows: Map<string, KubeObject>;
  state: ResourceListState;
  listeners: Set<() => void>;
  refs: number;
  /** Set once the backend answered; `closed` entries unsubscribe on arrival. */
  subscriptionId: string | null;
  closed: boolean;
}

const entries = new Map<string, Entry>();

function entryKey(clusterId: string, r: ResourceRef): string {
  return JSON.stringify([clusterId, r.group, r.plural]);
}

function notify(entry: Entry): void {
  for (const listener of [...entry.listeners]) listener();
}

function keyOf(key: ObjectKey): string {
  return `${key.namespace ?? ""}/${key.name}`;
}

/** Applies one event and publishes a single new state for it. */
function apply(entry: Entry, event: WatchEvent): void {
  const { state } = entry;
  switch (event.type) {
    case "snapshot": {
      entry.rows = new Map(
        (event.items as unknown as KubeObject[]).map((o) => [objectKey(o), o]),
      );
      entry.state = {
        ...state,
        items: [...entry.rows.values()],
        loading: false,
      };
      break;
    }
    case "batch": {
      for (const key of event.deletes) entry.rows.delete(keyOf(key));
      for (const o of event.upserts as unknown as KubeObject[]) {
        entry.rows.set(objectKey(o), o);
      }
      entry.state = { ...state, items: [...entry.rows.values()] };
      break;
    }
    case "status": {
      const final =
        event.status === "notServed" || event.status === "forbidden";
      entry.state = {
        ...state,
        status: event.status,
        message: event.message,
        loading: final ? false : state.loading,
      };
      break;
    }
  }
  notify(entry);
}

function open(clusterId: string, resource: ResourceRef): Entry {
  const entry: Entry = {
    rows: new Map(),
    state: { items: [], status: "syncing", message: null, loading: true },
    listeners: new Set(),
    refs: 0,
    subscriptionId: null,
    closed: false,
  };
  api
    .resourcesSubscribe(clusterId, resource, (event) => {
      if (!entry.closed) apply(entry, event);
    })
    .then(
      (id) => {
        entry.subscriptionId = id;
        if (entry.closed) void api.resourcesUnsubscribe(id).catch(() => {});
      },
      (error) => {
        if (entry.closed) return;
        entry.state = {
          ...entry.state,
          status: "notServed",
          message: failureMessage(error),
          loading: false,
        };
        notify(entry);
      },
    );
  return entry;
}

function acquire(key: string, clusterId: string, resource: ResourceRef): Entry {
  let entry = entries.get(key);
  if (!entry) {
    entry = open(clusterId, resource);
    entries.set(key, entry);
  }
  entry.refs += 1;
  return entry;
}

function release(key: string, entry: Entry): void {
  entry.refs -= 1;
  if (entry.refs > 0) return;
  entry.closed = true;
  if (entries.get(key) === entry) entries.delete(key);
  if (entry.subscriptionId !== null) {
    void api.resourcesUnsubscribe(entry.subscriptionId).catch(() => {});
  }
}

/**
 * The live objects of a resource. One subscription is kept per cluster, group and
 * plural, and ended when the last component using it goes away.
 */
export function useResourceList(
  clusterId: string,
  resource: ResourceRef | null,
): ResourceListState {
  const key = resource ? entryKey(clusterId, resource) : null;
  // The effect depends on the identity in `key`, so it reads the latest props from a ref.
  const latest = useRef({ clusterId, resource });
  latest.current = { clusterId, resource };
  const [entry, setEntry] = useState<Entry | null>(null);

  useEffect(() => {
    const { clusterId: cluster, resource: wanted } = latest.current;
    if (key === null || wanted === null) {
      setEntry(null);
      return;
    }
    const acquired = acquire(key, cluster, wanted);
    setEntry(acquired);
    return () => release(key, acquired);
  }, [key]);

  const subscribe = useCallback(
    (listener: () => void) => {
      if (!entry) return () => {};
      entry.listeners.add(listener);
      return () => entry.listeners.delete(listener);
    },
    [entry],
  );
  const snapshot = useCallback(() => entry?.state ?? IDLE, [entry]);
  const shown = useSyncExternalStore(subscribe, snapshot);
  // Until the effect has run for this key, showing the old entry would leak rows
  // across clusters, so the state of the entry that belongs to `key` is read.
  const current = key === null ? undefined : entries.get(key);
  if (key === null) return IDLE;
  return current && current !== entry ? current.state : shown;
}

export function useApiResources(clusterId: string): {
  resources: ApiResourceInfo[];
  loading: boolean;
  error: string | null;
  refresh(): Promise<void>;
} {
  const [state, setState] = useState<{
    clusterId: string;
    resources: ApiResourceInfo[];
    loading: boolean;
    error: string | null;
  }>({ clusterId, resources: [], loading: true, error: null });

  const load = useCallback(
    async (refresh: boolean, isCurrent: () => boolean) => {
      setState((s) => ({ ...s, clusterId, loading: true, error: null }));
      try {
        const resources = await api.resourcesDiscover(clusterId, refresh);
        if (isCurrent()) {
          setState({ clusterId, resources, loading: false, error: null });
        }
      } catch (error) {
        if (isCurrent()) {
          setState({
            clusterId,
            resources: [],
            loading: false,
            error: failureMessage(error),
          });
        }
      }
    },
    [clusterId],
  );

  useEffect(() => {
    let current = true;
    void load(false, () => current);
    return () => {
      current = false;
    };
  }, [load]);

  const refresh = useCallback(() => load(true, () => true), [load]);
  const own = state.clusterId === clusterId;
  return {
    resources: own ? state.resources : [],
    loading: own ? state.loading : true,
    error: own ? state.error : null,
    refresh,
  };
}

export function findResource(
  resources: ApiResourceInfo[],
  group: string,
  plural: string,
): ApiResourceInfo | undefined {
  return resources.find(
    (r) => r.resource.group === group && r.resource.plural === plural,
  );
}

export function resetResourcesForTest(): void {
  for (const entry of entries.values()) {
    entry.closed = true;
    entry.listeners.clear();
  }
  entries.clear();
}
