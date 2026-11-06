import { create, type StoreApi, type UseBoundStore } from "zustand";
import type { ResourceRef } from "../ipc/generated/ResourceRef";

const MIN_HEIGHT = 120;
const MAX_HEIGHT_SHARE = 0.8;
const DEFAULT_HEIGHT = 320;

// Phase 4 adds terminal and logs tab kinds and persistence.
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
    };

export interface DockState {
  tabs: DockTab[];
  activeId: string | null;
  height: number;
  minimized: boolean;
  /** Shows the dock on `tab`. An edit tab for the same object is focused instead. */
  open(tab: DockTab): void;
  close(id: string): void;
  activate(id: string): void;
  setHeight(px: number): void;
  setMinimized(v: boolean): void;
  setDirty(id: string, dirty: boolean): void;
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

export const useDock: UseBoundStore<StoreApi<DockState>> = create<DockState>(
  (set) => ({
    tabs: [],
    activeId: null,
    height: DEFAULT_HEIGHT,
    minimized: false,
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
    setHeight: (px) =>
      set({
        height: Math.max(
          MIN_HEIGHT,
          Math.min(px, window.innerHeight * MAX_HEIGHT_SHARE),
        ),
      }),
    setMinimized: (v) => set({ minimized: v }),
    setDirty: (id, dirty) =>
      set((state) =>
        state.tabs.some((t) => t.id === id && t.dirty !== dirty)
          ? {
              tabs: state.tabs.map((t) => (t.id === id ? { ...t, dirty } : t)),
            }
          : state,
      ),
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

let createTabs = 0;

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
  useDock.setState({
    tabs: [],
    activeId: null,
    height: DEFAULT_HEIGHT,
    minimized: false,
  });
}
