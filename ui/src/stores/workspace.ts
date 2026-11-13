import { create, type StoreApi, type UseBoundStore } from "zustand";
import {
  defaultLayout,
  initialView,
  parseLayout,
  prune,
  reduce,
  type WorkspaceAction,
  type WorkspaceLayout,
} from "../features/workspace/layout";
import { api } from "../ipc/api";
import type { ConnectionState } from "../ipc/generated/ConnectionState";
import type { JsonValue } from "../ipc/generated/serde_json/JsonValue";
import { type CatalogState, useCatalog } from "./catalog";

/** The ui-state key of the layout (spec E §15.2). */
export const WORKSPACE_KEY = "workspace";
/** As `useUiState`: a change is saved 300 ms after the last one. */
export const WORKSPACE_SAVE_DELAY_MS = 300;

export interface WorkspaceState {
  layout: WorkspaceLayout;
  /** True once the saved layout was read, or found missing or unreadable. */
  restored: boolean;
  /**
   * The namespace each tab's Pods view shows, by tab id: null for all namespaces.
   * A tab has no entry until its view picks one. Kept in memory only.
   */
  namespaces: Record<string, string | null>;
  dispatch(action: WorkspaceAction): void;
  setNamespace(tabId: string, namespace: string | null): void;
}

const INITIAL = {
  layout: defaultLayout(),
  restored: false,
  namespaces: {},
} satisfies Partial<WorkspaceState>;

export const useWorkspace: UseBoundStore<StoreApi<WorkspaceState>> =
  create<WorkspaceState>((set, get) => ({
    ...INITIAL,
    dispatch(action) {
      const layout = reduce(get().layout, action);
      if (layout !== get().layout) set({ layout });
    },
    setNamespace(tabId, namespace) {
      set({ namespaces: { ...get().namespaces, [tabId]: namespace } });
    },
  }));

/** Saves the layout 300 ms after the last change, and at once on `pagehide`. */
function startWriting(): () => void {
  let pending: WorkspaceLayout | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function flush(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const next = pending;
    pending = null;
    if (next) {
      // A failed write is ignored, as `useUiState` does: the next change writes again.
      void api
        .uiStateSet(WORKSPACE_KEY, next as unknown as JsonValue)
        .catch(() => {});
    }
  }

  const unsubscribe = useWorkspace.subscribe((state, previous) => {
    if (state.layout === previous.layout) return;
    pending = state.layout;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(flush, WORKSPACE_SAVE_DELAY_MS);
  });
  window.addEventListener("pagehide", flush);
  return () => {
    unsubscribe();
    window.removeEventListener("pagehide", flush);
    if (timer !== null) clearTimeout(timer);
  };
}

/** Drops the tabs of removed clusters now and whenever the catalog changes. */
function startPruning(): () => void {
  function check(catalog: CatalogState): void {
    if (catalog.loading || catalog.error !== null) return;
    const { layout } = useWorkspace.getState();
    const next = prune(
      layout,
      catalog.clusters.map((c) => c.id),
    );
    if (next !== layout) useWorkspace.setState({ layout: next });
  }
  check(useCatalog.getState());
  return useCatalog.subscribe((catalog, previous) => {
    if (
      catalog.clusters !== previous.clusters ||
      catalog.loading !== previous.loading
    ) {
      check(catalog);
    }
  });
}

let restoring: Promise<void> | null = null;
let stops: (() => void)[] = [];

/**
 * Reads the saved layout once, applies it, then keeps it saved and pruned. The
 * Workspace page and `openInWorkspace` call it; the page shows a spinner until then.
 */
export function restoreWorkspace(): Promise<void> {
  restoring ??= api
    .uiStateGet(WORKSPACE_KEY)
    .catch(() => null)
    .then((value) => {
      useWorkspace.setState({ layout: parseLayout(value), restored: true });
      stops = [startWriting(), startPruning()];
    });
  return restoring;
}

const DISCONNECTED: ConnectionState = { status: "disconnected" };

/**
 * Opens a cluster in the Workspace, as a hotbar click does there: in the focused pane,
 * or with `side` in a new pane to its right (spec E §15.1). A Failed cluster opens on
 * its Overview, any other on its Pods.
 */
export async function openInWorkspace(
  clusterId: string,
  side: boolean,
): Promise<void> {
  await restoreWorkspace();
  const state =
    useCatalog.getState().clusters.find((c) => c.id === clusterId)?.state ??
    DISCONNECTED;
  useWorkspace
    .getState()
    .dispatch({ type: "open", clusterId, side, view: initialView(state) });
}

export function resetWorkspaceForTest(): void {
  for (const stop of stops) stop();
  stops = [];
  restoring = null;
  useWorkspace.setState({ ...INITIAL, layout: defaultLayout() });
}
