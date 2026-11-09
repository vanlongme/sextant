import { create, type StoreApi, type UseBoundStore } from "zustand";
import type { ResourceRef } from "../ipc/generated/ResourceRef";
import type { KubeObject } from "../kinds/objects";

export const DOCK_MIN_HEIGHT = 120;
export const DOCK_DEFAULT_HEIGHT = 320;
const MAX_HEIGHT_SHARE = 0.8;

/** The tail a new Logs tab reads. */
export const DEFAULT_LOG_TAIL = 1000;

export function dockMaxHeight(): number {
  return window.innerHeight * MAX_HEIGHT_SHARE;
}

/** `px` within [120, 80 % of the window]. */
export function clampDockHeight(px: number): number {
  return Math.max(DOCK_MIN_HEIGHT, Math.min(px, dockMaxHeight()));
}

/**
 * What a Logs tab reads and how it shows it. A type alias rather than an interface,
 * so the saved dock layout can hold it as JSON.
 */
export type LogTabOptions = {
  /** "all", or one Pod's name. Used by workload tabs only. */
  pod: string;
  /** null: every container. */
  container: string | null;
  /** 100, 1000, or null for all lines. */
  tail: number | null;
  follow: boolean;
  previous: boolean;
  timestamps: boolean;
  wrap: boolean;
};

export type DockTab =
  | {
      id: string;
      kind: "edit";
      clusterId: string;
      title: string;
      resource: ResourceRef;
      namespace?: string;
      name: string;
      dirty: boolean;
    }
  | {
      id: string;
      kind: "create";
      clusterId: string;
      title: string;
      dirty: boolean;
    }
  | {
      id: string;
      kind: "logs";
      clusterId: string;
      title: string;
      resource: ResourceRef;
      namespace: string;
      name: string;
      options: LogTabOptions;
      dirty: false;
    }
  | {
      id: string;
      kind: "terminal";
      clusterId: string;
      title: string;
      dirty: false;
    }
  | {
      id: string;
      kind: "shell";
      clusterId: string;
      title: string;
      dirty: false;
      namespace: string;
      pod: string;
      container: string | null;
    }
  | {
      id: string;
      kind: "attach";
      clusterId: string;
      title: string;
      dirty: false;
      namespace: string;
      pod: string;
      container: string | null;
    }
  | {
      id: string;
      kind: "nodeShell";
      clusterId: string;
      title: string;
      dirty: false;
      node: string;
    };

export type LogsDockTab = Extract<DockTab, { kind: "logs" }>;
export type TerminalDockTab = Extract<DockTab, { kind: "terminal" }>;
export type PodSessionDockTab = Extract<DockTab, { kind: "shell" | "attach" }>;
export type NodeShellDockTab = Extract<DockTab, { kind: "nodeShell" }>;
/** A tab whose body is a terminal session. */
export type SessionDockTab =
  | TerminalDockTab
  | PodSessionDockTab
  | NodeShellDockTab;

type EditableTab = Extract<DockTab, { kind: "edit" | "create" }>;

function canBeDirty(tab: DockTab): tab is EditableTab {
  return tab.kind === "edit" || tab.kind === "create";
}

export function isSessionTab(tab: DockTab): tab is SessionDockTab {
  return (
    tab.kind === "terminal" ||
    tab.kind === "shell" ||
    tab.kind === "attach" ||
    tab.kind === "nodeShell"
  );
}

/** What the dock keeps across restarts (spec §7.1). */
export interface DockLayout {
  height: number;
  minimized: boolean;
  activeId: string | null;
  tabs: DockTab[];
}

export interface DockState {
  tabs: DockTab[];
  activeId: string | null;
  height: number;
  minimized: boolean;
  /** False until the saved layout was applied. The dock waits for it. */
  restored: boolean;
  /**
   * Shows the dock on `tab`. A tab for the same object is focused instead, and a Logs
   * tab keeps its options.
   */
  open(tab: DockTab): void;
  close(id: string): void;
  activate(id: string): void;
  setHeight(px: number): void;
  setMinimized(v: boolean): void;
  /** Edit and create tabs only: the other kinds are never dirty. */
  setDirty(id: string, dirty: boolean): void;
  setLogOptions(id: string, patch: Partial<LogTabOptions>): void;
  /** The container of a Shell or Attach tab. Other tabs are left alone. */
  setContainer(id: string, container: string): void;
  /** Titles the terminal tab of each cluster given after the cluster's catalog name. */
  renameTerminals(clusters: readonly { id: string; name: string }[]): void;
  /**
   * Applies the saved layout. Tabs opened before it arrived stay after the saved
   * ones, and the one the user opened last stays active.
   */
  restore(layout: DockLayout): void;
  /** Drops the tabs, and their drafts, of clusters not in `clusterIds`. */
  keepClusters(clusterIds: readonly string[]): void;
  /** Moves a tab to `toIndex` among its own cluster's tabs; the others keep their places. */
  move(id: string, toIndex: number): void;
}

function sameTab(a: DockTab, b: DockTab): boolean {
  if (a.id === b.id) return true;
  return (
    a.kind === "edit" &&
    b.kind === "edit" &&
    a.clusterId === b.clusterId &&
    a.resource.group === b.resource.group &&
    a.resource.plural === b.resource.plural &&
    a.namespace === b.namespace &&
    a.name === b.name
  );
}

/**
 * What a tab was holding when it left the screen, by tab id. A cluster's tabs
 * unmount when the user switches cluster or the connection drops, and unsaved
 * text has to be there when they come back. Goes away with the tab.
 */
const drafts = new Map<string, unknown>();

export function readDraft<T>(id: string): T | undefined {
  return drafts.get(id) as T | undefined;
}

export function writeDraft(id: string, draft: unknown): void {
  if (useDock.getState().tabs.some((t) => t.id === id)) drafts.set(id, draft);
}

export function clearDraft(id: string): void {
  drafts.delete(id);
}

/** The highest `create-<n>` handed out or restored. */
let createTabs = 0;

const CREATE_ID = /^create-(\d+)$/;

export const useDock: UseBoundStore<StoreApi<DockState>> = create<DockState>(
  (set, get) => ({
    tabs: [],
    activeId: null,
    height: DOCK_DEFAULT_HEIGHT,
    minimized: false,
    restored: false,
    open: (tab) =>
      set((state) => {
        const existing = state.tabs.find((t) => sameTab(t, tab));
        return existing
          ? { activeId: existing.id, minimized: false }
          : { tabs: [...state.tabs, tab], activeId: tab.id, minimized: false };
      }),
    close: (id) => {
      drafts.delete(id);
      set((state) => {
        const closing = state.tabs.find((t) => t.id === id);
        if (!closing) return state;
        const tabs = state.tabs.filter((t) => t.id !== id);
        if (state.activeId !== id) return { tabs };
        // The next tab of the same cluster, or else the one before.
        const own = state.tabs.filter((t) => t.clusterId === closing.clusterId);
        const at = own.indexOf(closing);
        const neighbour = own[at + 1] ?? own[at - 1];
        return { tabs, activeId: neighbour?.id ?? null };
      });
    },
    activate: (id) => set({ activeId: id }),
    setHeight: (px) => set({ height: clampDockHeight(px) }),
    setMinimized: (v) => set({ minimized: v }),
    setDirty: (id, dirty) =>
      set((state) =>
        state.tabs.some(
          (t) => t.id === id && canBeDirty(t) && t.dirty !== dirty,
        )
          ? {
              tabs: state.tabs.map((t) =>
                t.id === id && canBeDirty(t) ? { ...t, dirty } : t,
              ),
            }
          : state,
      ),
    setLogOptions: (id, patch) =>
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.id === id && t.kind === "logs"
            ? { ...t, options: { ...t.options, ...patch } }
            : t,
        ),
      })),
    setContainer: (id, container) =>
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.id === id && (t.kind === "shell" || t.kind === "attach")
            ? { ...t, container }
            : t,
        ),
      })),
    renameTerminals: (clusters) =>
      set((state) => {
        const names = new Map(clusters.map((c) => [c.id, c.name] as const));
        let changed = false;
        const tabs = state.tabs.map((t) => {
          if (t.kind !== "terminal") return t;
          const name = names.get(t.clusterId);
          if (name === undefined || terminalTitle(name) === t.title) return t;
          changed = true;
          return { ...t, title: terminalTitle(name) };
        });
        return changed ? { tabs } : state;
      }),
    restore: (layout) => {
      for (const tab of layout.tabs) {
        const n = CREATE_ID.exec(tab.id);
        if (n) createTabs = Math.max(createTabs, Number(n[1]));
      }
      set((state) => {
        const saved = new Set(layout.tabs.map((t) => t.id));
        const early = state.tabs.filter((t) => !saved.has(t.id));
        const openedEarly = state.activeId !== null;
        return {
          tabs: [...layout.tabs, ...early],
          activeId: openedEarly ? state.activeId : layout.activeId,
          minimized: openedEarly ? state.minimized : layout.minimized,
          height: layout.height,
          restored: true,
        };
      });
    },
    keepClusters: (clusterIds) => {
      const keep = new Set(clusterIds);
      const { tabs, activeId } = get();
      const dropped = tabs.filter((t) => !keep.has(t.clusterId));
      if (dropped.length === 0) return;
      for (const tab of dropped) drafts.delete(tab.id);
      set({
        tabs: tabs.filter((t) => keep.has(t.clusterId)),
        activeId: dropped.some((t) => t.id === activeId) ? null : activeId,
      });
    },
    move: (id, toIndex) =>
      set((state) => {
        const tab = state.tabs.find((t) => t.id === id);
        if (!tab) return state;
        const own = state.tabs.filter((t) => t.clusterId === tab.clusterId);
        const from = own.indexOf(tab);
        const to = Math.max(0, Math.min(toIndex, own.length - 1));
        if (from === to) return state;
        const reordered = own.filter((t) => t !== tab);
        reordered.splice(to, 0, tab);
        // The cluster's slots in the whole list stay where they are.
        const slots = reordered.values();
        return {
          tabs: state.tabs.map((t) =>
            t.clusterId === tab.clusterId ? (slots.next().value ?? t) : t,
          ),
        };
      }),
  }),
);

export function tabsForCluster(tabs: DockTab[], clusterId: string): DockTab[] {
  return tabs.filter((t) => t.clusterId === clusterId);
}

/** The tab that edits one object. */
export function editTab(
  clusterId: string,
  resource: ResourceRef,
  namespace: string | undefined,
  name: string,
): DockTab {
  return {
    id: `edit:${clusterId}:${resource.group}/${resource.plural}:${namespace ?? ""}/${name}`,
    kind: "edit",
    clusterId,
    title: `${resource.kind} ${namespace ? `${namespace}/` : ""}${name}`,
    resource,
    namespace,
    name,
    dirty: false,
  };
}

export function logsTabId(
  clusterId: string,
  resource: ResourceRef,
  namespace: string,
  name: string,
): string {
  return `logs:${clusterId}:${resource.group}/${resource.plural}:${namespace}/${name}`;
}

export function logsTitle(name: string): string {
  return `Logs · ${name}`;
}

/** Whether a Logs tab reads one Pod, rather than the Pods of a workload. */
export function isPodTab(tab: LogsDockTab): boolean {
  return tab.resource.group === "" && tab.resource.plural === "pods";
}

/**
 * The tab that reads an object's logs. A Pod starts on its first container, a
 * workload on every container of all its Pods.
 */
export function logsTab(
  clusterId: string,
  resource: ResourceRef,
  object: KubeObject,
): LogsDockTab {
  const namespace = object.metadata.namespace ?? "";
  const name = object.metadata.name;
  const pod = resource.group === "" && resource.plural === "pods";
  const first: unknown = pod ? object.spec?.containers?.[0]?.name : undefined;
  return {
    id: logsTabId(clusterId, resource, namespace, name),
    kind: "logs",
    clusterId,
    title: logsTitle(name),
    resource,
    namespace,
    name,
    options: {
      pod: "all",
      container: typeof first === "string" ? first : null,
      tail: DEFAULT_LOG_TAIL,
      follow: true,
      previous: false,
      timestamps: true,
      wrap: false,
    },
    dirty: false,
  };
}

interface ContainerState {
  name: string;
  state?: { running?: unknown };
}

/**
 * The container a Shell or Attach tab starts on: the first of `spec.containers` that
 * runs, else the first one. Init and ephemeral containers are never offered.
 */
export function defaultContainer(pod: KubeObject): string | null {
  const names: string[] = (pod.spec?.containers ?? []).map(
    (c: { name: string }) => c.name,
  );
  const states: ContainerState[] = pod.status?.containerStatuses ?? [];
  const running = names.find((name) =>
    states.some((s) => s.name === name && s.state?.running !== undefined),
  );
  return running ?? names[0] ?? null;
}

export function terminalTabId(clusterId: string): string {
  return `terminal:${clusterId}`;
}

/** "Terminal" until the catalog has given the cluster's name. */
export function terminalTitle(clusterName: string | null): string {
  return clusterName === null ? "Terminal" : `Terminal · ${clusterName}`;
}

/** The cluster's one local terminal. */
export function terminalTab(
  clusterId: string,
  clusterName: string | null,
): TerminalDockTab {
  return {
    id: terminalTabId(clusterId),
    kind: "terminal",
    clusterId,
    title: terminalTitle(clusterName),
    dirty: false,
  };
}

export function podSessionTab(
  kind: "shell" | "attach",
  clusterId: string,
  namespace: string,
  pod: string,
  container: string | null,
): PodSessionDockTab {
  return {
    id: `${kind}:${clusterId}:${namespace}/${pod}`,
    kind,
    clusterId,
    title: `${kind === "shell" ? "Shell" : "Attach"} · ${pod}`,
    dirty: false,
    namespace,
    pod,
    container,
  };
}

/** A shell in the Pod, on its default container. */
export function shellTab(
  clusterId: string,
  pod: KubeObject,
): PodSessionDockTab {
  return podSessionTab(
    "shell",
    clusterId,
    pod.metadata.namespace ?? "",
    pod.metadata.name,
    defaultContainer(pod),
  );
}

/** An attach to the PID 1 of the Pod's default container. */
export function attachTab(
  clusterId: string,
  pod: KubeObject,
): PodSessionDockTab {
  return podSessionTab(
    "attach",
    clusterId,
    pod.metadata.namespace ?? "",
    pod.metadata.name,
    defaultContainer(pod),
  );
}

export function nodeShellTabFor(
  clusterId: string,
  node: string,
): NodeShellDockTab {
  return {
    id: `node-shell:${clusterId}:${node}`,
    kind: "nodeShell",
    clusterId,
    title: `Shell · ${node}`,
    dirty: false,
    node,
  };
}

/** A root shell on the node. */
export function nodeShellTab(
  clusterId: string,
  node: KubeObject,
): NodeShellDockTab {
  return nodeShellTabFor(clusterId, node.metadata.name);
}

/** A new tab for creating resources. */
export function newCreateTab(clusterId: string): DockTab {
  createTabs += 1;
  return {
    id: `create-${createTabs}`,
    kind: "create",
    clusterId,
    title: "Create",
    dirty: false,
  };
}

export function resetDockForTest(): void {
  drafts.clear();
  createTabs = 0;
  useDock.setState({
    tabs: [],
    activeId: null,
    height: DOCK_DEFAULT_HEIGHT,
    minimized: false,
    restored: true,
  });
}
