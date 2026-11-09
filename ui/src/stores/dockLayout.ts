import { api } from "../ipc/api";
import type { ResourceRef } from "../ipc/generated/ResourceRef";
import type { JsonValue } from "../ipc/generated/serde_json/JsonValue";
import { type CatalogState, useCatalog } from "./catalog";
import {
  clampDockHeight,
  DOCK_DEFAULT_HEIGHT,
  type DockLayout,
  type DockState,
  type DockTab,
  editTab,
  type LogTabOptions,
  logsTabId,
  logsTitle,
  useDock,
} from "./dock";

export const DOCK_LAYOUT_KEY = "dock:layout";
export const LAYOUT_SAVE_DELAY_MS = 300;

/** A tab as saved (spec §7.1): its title is rebuilt on load, and it comes back clean. */
export type SavedTab =
  | {
      id: string;
      kind: "edit";
      clusterId: string;
      resource: ResourceRef;
      namespace: string | null;
      name: string;
    }
  | { id: string; kind: "create"; clusterId: string }
  | {
      id: string;
      kind: "logs";
      clusterId: string;
      resource: ResourceRef;
      namespace: string;
      name: string;
      options: LogTabOptions;
    };

export type SavedLayout = {
  version: 1;
  height: number;
  minimized: boolean;
  activeId: string | null;
  tabs: SavedTab[];
};

type JsonRecord = { [key in string]: JsonValue };

function defaults(): DockLayout {
  return {
    height: DOCK_DEFAULT_HEIGHT,
    minimized: false,
    activeId: null,
    tabs: [],
  };
}

function isRecord(v: JsonValue | undefined): v is JsonRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isText(v: JsonValue | undefined): v is string {
  return typeof v === "string";
}

function isName(v: JsonValue | undefined): v is string {
  return typeof v === "string" && v !== "";
}

function isFlag(v: JsonValue | undefined): v is boolean {
  return typeof v === "boolean";
}

function parseResource(v: JsonValue | undefined): ResourceRef | null {
  if (!isRecord(v)) return null;
  const { group, version, plural, kind, namespaced } = v;
  if (
    !isText(group) ||
    !isName(version) ||
    !isName(plural) ||
    !isName(kind) ||
    !isFlag(namespaced)
  ) {
    return null;
  }
  return { group, version, plural, kind, namespaced };
}

function parseOptions(v: JsonValue | undefined): LogTabOptions | null {
  if (!isRecord(v)) return null;
  const { pod, container, tail, follow, previous, timestamps, wrap } = v;
  if (!isName(pod) || !(container === null || isName(container))) return null;
  if (!(tail === null || tail === 100 || tail === 1000)) return null;
  if (
    !isFlag(follow) ||
    !isFlag(previous) ||
    !isFlag(timestamps) ||
    !isFlag(wrap)
  ) {
    return null;
  }
  return { pod, container, tail, follow, previous, timestamps, wrap };
}

function parseTab(v: JsonValue | undefined): DockTab | null {
  if (!isRecord(v)) return null;
  const { id, kind, clusterId, namespace, name } = v;
  if (!isName(id) || !isName(clusterId)) return null;
  switch (kind) {
    case "create":
      return /^create-\d+$/.test(id)
        ? { id, kind: "create", clusterId, title: "Create", dirty: false }
        : null;
    case "edit": {
      const resource = parseResource(v.resource);
      if (!resource || !isName(name)) return null;
      if (!(namespace === null || isName(namespace))) return null;
      const tab = editTab(clusterId, resource, namespace ?? undefined, name);
      return tab.id === id ? tab : null;
    }
    case "logs": {
      const resource = parseResource(v.resource);
      const options = parseOptions(v.options);
      if (!resource || !options || !isName(namespace) || !isName(name))
        return null;
      if (id !== logsTabId(clusterId, resource, namespace, name)) return null;
      return {
        id,
        kind: "logs",
        clusterId,
        title: logsTitle(name),
        resource,
        namespace,
        name,
        options,
        dirty: false,
      };
    }
    default:
      return null;
  }
}

/**
 * The saved layout, or the defaults. Pure. A wrong version or shape gives the
 * defaults; a malformed tab is dropped alone; the height is clamped; an `activeId`
 * that names no tab becomes null.
 */
export function parseLayout(value: JsonValue | null): DockLayout {
  if (!isRecord(value)) return defaults();
  const { version, height, minimized, activeId, tabs } = value;
  if (
    version !== 1 ||
    !Array.isArray(tabs) ||
    typeof height !== "number" ||
    !Number.isFinite(height) ||
    !isFlag(minimized) ||
    !(activeId === null || isText(activeId))
  ) {
    return defaults();
  }
  const parsed: DockTab[] = [];
  for (const raw of tabs) {
    const tab = parseTab(raw);
    if (tab && !parsed.some((t) => t.id === tab.id)) parsed.push(tab);
  }
  return {
    height: clampDockHeight(height),
    minimized,
    activeId: parsed.some((t) => t.id === activeId) ? activeId : null,
    tabs: parsed,
  };
}

function savedTab(tab: DockTab): SavedTab {
  switch (tab.kind) {
    case "edit":
      return {
        id: tab.id,
        kind: "edit",
        clusterId: tab.clusterId,
        resource: tab.resource,
        namespace: tab.namespace ?? null,
        name: tab.name,
      };
    case "create":
      return { id: tab.id, kind: "create", clusterId: tab.clusterId };
    case "logs":
      return {
        id: tab.id,
        kind: "logs",
        clusterId: tab.clusterId,
        resource: tab.resource,
        namespace: tab.namespace,
        name: tab.name,
        options: tab.options,
      };
  }
}

export function serializeLayout(
  state: Pick<DockState, "height" | "minimized" | "activeId" | "tabs">,
): SavedLayout {
  return {
    version: 1,
    height: state.height,
    minimized: state.minimized,
    activeId: state.activeId,
    tabs: state.tabs.map(savedTab),
  };
}

/**
 * Writes the layout 300 ms after the last change to a saved field, and at once on
 * `pagehide` when a write is pending. A failed write is ignored, as `useUiState`
 * does: the layout is a convenience, and the next change writes it again.
 */
function startWriting(): () => void {
  let written = JSON.stringify(serializeLayout(useDock.getState()));
  let pending: SavedLayout | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function flush(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const next = pending;
    pending = null;
    if (next) void api.uiStateSet(DOCK_LAYOUT_KEY, next).catch(() => {});
  }

  const unsubscribe = useDock.subscribe((state) => {
    const layout = serializeLayout(state);
    const text = JSON.stringify(layout);
    if (text === written) return;
    written = text;
    pending = layout;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(flush, LAYOUT_SAVE_DELAY_MS);
  });
  window.addEventListener("pagehide", flush);
  return () => {
    unsubscribe();
    window.removeEventListener("pagehide", flush);
    if (timer !== null) clearTimeout(timer);
  };
}

/** Drops the tabs of unknown clusters once, when the catalog has loaded without error. */
function pruneOnce(): () => void {
  let done = false;
  function check(catalog: CatalogState): void {
    if (done || catalog.loading || catalog.error !== null) return;
    done = true;
    useDock.getState().keepClusters(catalog.clusters.map((c) => c.id));
  }
  check(useCatalog.getState());
  if (done) return () => {};
  const unsubscribe = useCatalog.subscribe((catalog) => {
    check(catalog);
    if (done) unsubscribe();
  });
  return unsubscribe;
}

let restoring: Promise<void> | null = null;
let stops: (() => void)[] = [];

/**
 * Reads the saved layout once, applies it, then keeps it saved. `bootstrap` calls it
 * before the first render, and the dock shows nothing until it is applied.
 */
export function restoreDockLayout(): Promise<void> {
  restoring ??= api
    .uiStateGet(DOCK_LAYOUT_KEY)
    .catch(() => null)
    .then((value) => {
      useDock.getState().restore(parseLayout(value));
      stops = [startWriting(), pruneOnce()];
    });
  return restoring;
}

export function resetDockLayoutForTest(): void {
  for (const stop of stops) stop();
  stops = [];
  restoring = null;
}
