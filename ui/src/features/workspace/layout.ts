/**
 * The Workspace layout of spec E §15.2: up to three panes side by side, each with its
 * own tabs. Pure: `reduce` and `prune` return a new layout, or the same object when
 * an action is refused or changes nothing. `stores/workspace.ts` keeps and saves it.
 */
import type { ConnectionState } from "../../ipc/generated/ConnectionState";

export type WorkspaceView = "overview" | "pods" | "events";

export interface WorkspaceTab {
  id: string;
  clusterId: string;
  view: WorkspaceView;
  pinned: boolean;
}

export interface WorkspacePane {
  id: string;
  tabs: WorkspaceTab[];
  active: string | null;
}

export interface WorkspaceLayout {
  version: 1;
  panes: WorkspacePane[];
  focus: string;
  widths: number[];
  /** The number the next new tab or pane id is made from. */
  seq: number;
}

export type WorkspaceAction =
  | { type: "open"; clusterId: string; side: boolean; view: WorkspaceView }
  | { type: "activate"; tabId: string }
  | { type: "close"; tabId: string }
  | { type: "closeOthers"; tabId: string }
  | { type: "pin"; tabId: string }
  | { type: "unpin"; tabId: string }
  | { type: "setView"; tabId: string; view: WorkspaceView }
  | { type: "move"; tabId: string; paneId: string; index: number }
  | { type: "moveToNewPane"; tabId: string; paneId: string }
  | { type: "split"; tabId: string }
  | { type: "resize"; index: number; fraction: number }
  | { type: "equalize" }
  | { type: "focus"; paneId: string }
  | { type: "reset" };

export const MAX_PANES = 3;
export const MIN_WIDTH = 0.24;
export const VIEWS: readonly WorkspaceView[] = ["overview", "pods", "events"];
export const VIEW_LABELS: Record<WorkspaceView, string> = {
  overview: "Overview",
  pods: "Pods",
  events: "Events",
};

/** One empty pane with the whole width. */
export function defaultLayout(): WorkspaceLayout {
  return {
    version: 1,
    panes: [{ id: "p1", tabs: [], active: null }],
    focus: "p1",
    widths: [1],
    seq: 2,
  };
}

/** A Failed cluster opens on its Overview, any other on its Pods. */
export function initialView(state: ConnectionState): WorkspaceView {
  return state.status === "failed" ? "overview" : "pods";
}

export interface TabPlace {
  pane: WorkspacePane;
  paneIndex: number;
  tab: WorkspaceTab;
  tabIndex: number;
}

export function findTab(
  layout: WorkspaceLayout,
  tabId: string,
): TabPlace | null {
  for (const [paneIndex, pane] of layout.panes.entries()) {
    const tabIndex = pane.tabs.findIndex((t) => t.id === tabId);
    if (tabIndex >= 0) {
      return { pane, paneIndex, tab: pane.tabs[tabIndex], tabIndex };
    }
  }
  return null;
}

export function focusedPane(layout: WorkspaceLayout): WorkspacePane {
  return layout.panes.find((p) => p.id === layout.focus) ?? layout.panes[0];
}

export function activeTab(pane: WorkspacePane): WorkspaceTab | null {
  return pane.tabs.find((t) => t.id === pane.active) ?? null;
}

/** The cluster of the focused pane's active tab: its hotbar tile is marked active. */
export function focusedClusterId(layout: WorkspaceLayout): string | null {
  return activeTab(focusedPane(layout))?.clusterId ?? null;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "2 panes · 1 cluster · 3 tabs · 1 pinned" (spec E §15.4). */
export function layoutSummary(layout: WorkspaceLayout): string {
  const tabs = layout.panes.flatMap((p) => p.tabs);
  const clusters = new Set(tabs.map((t) => t.clusterId)).size;
  const pinned = tabs.filter((t) => t.pinned).length;
  return [
    plural(layout.panes.length, "pane", "panes"),
    plural(clusters, "cluster", "clusters"),
    plural(tabs.length, "tab", "tabs"),
    `${pinned} pinned`,
  ].join(" · ");
}

/** Which items of a tab's context menu apply (spec E §15.3). */
export interface TabActions {
  side: boolean;
  left: boolean;
  right: boolean;
  newPane: boolean;
  close: boolean;
  closeOthers: boolean;
}

export function tabActions(
  layout: WorkspaceLayout,
  tabId: string,
): TabActions | null {
  const place = findTab(layout, tabId);
  if (!place) return null;
  const { pane, paneIndex, tab } = place;
  const room = layout.panes.length < MAX_PANES;
  return {
    side: room,
    left: paneIndex > 0,
    right: paneIndex < layout.panes.length - 1,
    newPane: room && pane.tabs.length > 1,
    close: !tab.pinned,
    closeOthers: pane.tabs.some((t) => !t.pinned && t.id !== tabId),
  };
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/** Rounded to 4 places, with the rounding left on the last pane so they add up to 1. */
function settle(widths: number[]): number[] {
  const head = widths.slice(0, -1).map(round4);
  const rest = round4(1 - head.reduce((sum, w) => sum + w, 0));
  return [...head, rest];
}

function equal(count: number): number[] {
  return settle(Array.from({ length: count }, () => 1 / count));
}

function nextId(draft: WorkspaceLayout, prefix: "p" | "t"): string {
  const used = new Set(
    draft.panes.flatMap((p) => [p.id, ...p.tabs.map((t) => t.id)]),
  );
  let id = `${prefix}${draft.seq}`;
  draft.seq += 1;
  while (used.has(id)) {
    id = `${prefix}${draft.seq}`;
    draft.seq += 1;
  }
  return id;
}

function newTab(
  draft: WorkspaceLayout,
  clusterId: string,
  view: WorkspaceView,
): WorkspaceTab {
  return { id: nextId(draft, "t"), clusterId, view, pinned: false };
}

/** A new pane right of `afterIndex`, holding `tab`, focused; the widths become equal. */
function addPane(
  draft: WorkspaceLayout,
  afterIndex: number,
  tab: WorkspaceTab,
): void {
  const pane: WorkspacePane = {
    id: nextId(draft, "p"),
    tabs: [tab],
    active: tab.id,
  };
  draft.panes.splice(afterIndex + 1, 0, pane);
  draft.focus = pane.id;
  draft.widths = equal(draft.panes.length);
}

/** The tab that becomes active when the one at `index` leaves: the next, else the previous. */
function neighbour(tabs: WorkspaceTab[], index: number): string | null {
  return (tabs[index] ?? tabs[index - 1])?.id ?? null;
}

/**
 * Pinned tabs first, a valid active tab, no empty pane while others remain (its width
 * goes to its neighbours, and its focus to the pane on its left), and a valid focus.
 */
function normalize(draft: WorkspaceLayout): WorkspaceLayout {
  for (const pane of draft.panes) {
    pane.tabs = [
      ...pane.tabs.filter((t) => t.pinned),
      ...pane.tabs.filter((t) => !t.pinned),
    ];
    if (!pane.tabs.some((t) => t.id === pane.active)) {
      pane.active = pane.tabs[0]?.id ?? null;
    }
  }
  for (let i = draft.panes.length - 1; i >= 0; i--) {
    if (draft.panes.length === 1) break;
    if (draft.panes[i].tabs.length > 0) continue;
    const width = draft.widths[i];
    const left = i - 1;
    const right = i + 1 < draft.panes.length ? i + 1 : -1;
    if (left >= 0 && right >= 0) {
      draft.widths[left] += width / 2;
      draft.widths[right] += width / 2;
    } else {
      draft.widths[left >= 0 ? left : right] += width;
    }
    const wasFocused = draft.panes[i].id === draft.focus;
    draft.panes.splice(i, 1);
    draft.widths.splice(i, 1);
    if (wasFocused) draft.focus = draft.panes[Math.max(0, i - 1)].id;
  }
  if (!draft.panes.some((p) => p.id === draft.focus)) {
    draft.focus = draft.panes[0].id;
  }
  draft.widths = settle(draft.widths);
  return draft;
}

function copy(layout: WorkspaceLayout): WorkspaceLayout {
  return structuredClone(layout);
}

function open(
  layout: WorkspaceLayout,
  clusterId: string,
  side: boolean,
  view: WorkspaceView,
): WorkspaceLayout {
  const draft = copy(layout);
  const paneIndex = Math.max(
    0,
    draft.panes.findIndex((p) => p.id === draft.focus),
  );
  const pane = draft.panes[paneIndex];
  if (side && draft.panes.length < MAX_PANES && pane.tabs.length > 0) {
    addPane(draft, paneIndex, newTab(draft, clusterId, view));
    return normalize(draft);
  }
  const current = activeTab(pane);
  const there =
    current?.clusterId === clusterId
      ? current
      : pane.tabs.find((t) => t.clusterId === clusterId);
  if (there) {
    if (pane.active === there.id && draft.focus === pane.id) return layout;
    pane.active = there.id;
  } else {
    const tab = newTab(draft, clusterId, view);
    pane.tabs.push(tab);
    pane.active = tab.id;
  }
  draft.focus = pane.id;
  return normalize(draft);
}

function move(
  layout: WorkspaceLayout,
  tabId: string,
  paneId: string,
  index: number,
): WorkspaceLayout {
  const draft = copy(layout);
  const place = findTab(draft, tabId);
  const target = draft.panes.find((p) => p.id === paneId);
  if (!place || !target) return layout;
  const { pane: source, tab, tabIndex } = place;
  source.tabs.splice(tabIndex, 1);
  if (source !== target && source.active === tab.id) {
    source.active = neighbour(source.tabs, tabIndex);
  }
  let at = source === target && tabIndex < index ? index - 1 : index;
  const pinnedCount = target.tabs.filter((t) => t.pinned).length;
  at = tab.pinned ? Math.min(at, pinnedCount) : Math.max(at, pinnedCount);
  target.tabs.splice(Math.min(Math.max(at, 0), target.tabs.length), 0, tab);
  target.active = tab.id;
  draft.focus = target.id;
  return normalize(draft);
}

function moveToNewPane(
  layout: WorkspaceLayout,
  tabId: string,
  paneId: string,
): WorkspaceLayout {
  if (layout.panes.length >= MAX_PANES) return layout;
  const place = findTab(layout, tabId);
  const besideIndex = layout.panes.findIndex((p) => p.id === paneId);
  if (!place || besideIndex < 0) return layout;
  // Alone in its own pane, the tab would only end up where it is.
  if (place.pane.tabs.length === 1 && place.pane.id === paneId) return layout;
  const draft = copy(layout);
  const source = draft.panes[place.paneIndex];
  const [tab] = source.tabs.splice(place.tabIndex, 1);
  if (source.active === tab.id) {
    source.active = neighbour(source.tabs, place.tabIndex);
  }
  addPane(draft, besideIndex, tab);
  return normalize(draft);
}

function update(
  layout: WorkspaceLayout,
  tabId: string,
  change: (draft: WorkspaceLayout, place: TabPlace) => boolean,
): WorkspaceLayout {
  const draft = copy(layout);
  const place = findTab(draft, tabId);
  if (!place || !change(draft, place)) return layout;
  return normalize(draft);
}

export function reduce(
  layout: WorkspaceLayout,
  action: WorkspaceAction,
): WorkspaceLayout {
  switch (action.type) {
    case "open":
      return open(layout, action.clusterId, action.side, action.view);
    case "activate":
      return update(layout, action.tabId, (draft, { pane, tab }) => {
        if (pane.active === tab.id && draft.focus === pane.id) return false;
        pane.active = tab.id;
        draft.focus = pane.id;
        return true;
      });
    case "close":
      return update(layout, action.tabId, (_draft, place) => {
        const { pane, tab, tabIndex } = place;
        if (tab.pinned) return false;
        pane.tabs.splice(tabIndex, 1);
        if (pane.active === tab.id)
          pane.active = neighbour(pane.tabs, tabIndex);
        return true;
      });
    case "closeOthers":
      return update(layout, action.tabId, (_draft, { pane, tab }) => {
        const kept = pane.tabs.filter((t) => t.pinned || t.id === tab.id);
        if (kept.length === pane.tabs.length && pane.active === tab.id) {
          return false;
        }
        pane.tabs = kept;
        pane.active = tab.id;
        return true;
      });
    case "pin":
    case "unpin":
      return update(layout, action.tabId, (draft, { pane, tab }) => {
        const pinned = action.type === "pin";
        if (tab.pinned === pinned) return false;
        tab.pinned = pinned;
        pane.active = tab.id;
        draft.focus = pane.id;
        return true;
      });
    case "setView":
      return update(layout, action.tabId, (draft, { pane, tab }) => {
        if (tab.view === action.view) return false;
        tab.view = action.view;
        draft.focus = pane.id;
        return true;
      });
    case "move":
      return move(layout, action.tabId, action.paneId, action.index);
    case "moveToNewPane":
      return moveToNewPane(layout, action.tabId, action.paneId);
    case "split":
      return update(layout, action.tabId, (draft, { paneIndex, tab }) => {
        if (draft.panes.length >= MAX_PANES) return false;
        addPane(draft, paneIndex, newTab(draft, tab.clusterId, tab.view));
        return true;
      });
    case "resize": {
      const { index } = action;
      if (index < 0 || index >= layout.panes.length - 1) return layout;
      const pair = layout.widths[index] + layout.widths[index + 1];
      const left = round4(
        Math.min(Math.max(action.fraction, MIN_WIDTH), pair - MIN_WIDTH),
      );
      if (left === layout.widths[index]) return layout;
      const widths = [...layout.widths];
      widths[index] = left;
      widths[index + 1] = round4(pair - left);
      return { ...layout, widths: settle(widths) };
    }
    case "equalize": {
      const widths = equal(layout.panes.length);
      if (widths.every((w, i) => w === layout.widths[i])) return layout;
      return { ...layout, widths };
    }
    case "focus":
      if (
        layout.focus === action.paneId ||
        !layout.panes.some((p) => p.id === action.paneId)
      ) {
        return layout;
      }
      return { ...layout, focus: action.paneId };
    case "reset":
      return defaultLayout();
  }
}

/** Drops the tabs of clusters that are no longer in the catalog. */
export function prune(
  layout: WorkspaceLayout,
  clusterIds: readonly string[],
): WorkspaceLayout {
  const known = new Set(clusterIds);
  const gone = layout.panes.some((p) =>
    p.tabs.some((t) => !known.has(t.clusterId)),
  );
  if (!gone) return layout;
  const draft = copy(layout);
  for (const pane of draft.panes) {
    pane.tabs = pane.tabs.filter((t) => known.has(t.clusterId));
  }
  return normalize(draft);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isId(v: unknown): v is string {
  return typeof v === "string" && v !== "";
}

function parseTab(v: unknown): WorkspaceTab | null {
  if (!isRecord(v)) return null;
  const { id, clusterId, view, pinned } = v;
  if (!isId(id) || !isId(clusterId) || typeof pinned !== "boolean") {
    return null;
  }
  if (!VIEWS.includes(view as WorkspaceView)) return null;
  return { id, clusterId, view: view as WorkspaceView, pinned };
}

function parsePane(v: unknown): WorkspacePane | null {
  if (!isRecord(v) || !isId(v.id) || !Array.isArray(v.tabs)) return null;
  const tabs: WorkspaceTab[] = [];
  for (const raw of v.tabs) {
    const tab = parseTab(raw);
    if (!tab) return null;
    tabs.push(tab);
  }
  const { active } = v;
  if (!(active === null || tabs.some((t) => t.id === active))) return null;
  return { id: v.id, tabs, active: active as string | null };
}

/**
 * The stored layout, or the default one when the value has another version or the
 * wrong shape: 1 to 3 panes with unique ids, no empty pane beside others, widths of
 * at least 0.24 that add up to 1, a focus that names a pane, and a whole `seq`.
 */
export function parseLayout(value: unknown): WorkspaceLayout {
  if (!isRecord(value) || value.version !== 1) return defaultLayout();
  const { panes: rawPanes, widths, focus, seq } = value;
  if (
    !Array.isArray(rawPanes) ||
    rawPanes.length < 1 ||
    rawPanes.length > MAX_PANES ||
    !Array.isArray(widths) ||
    widths.length !== rawPanes.length ||
    !Number.isInteger(seq) ||
    (seq as number) < 0
  ) {
    return defaultLayout();
  }
  const panes: WorkspacePane[] = [];
  for (const raw of rawPanes) {
    const pane = parsePane(raw);
    if (!pane) return defaultLayout();
    panes.push(pane);
  }
  if (panes.length > 1 && panes.some((p) => p.tabs.length === 0)) {
    return defaultLayout();
  }
  const ids = panes.flatMap((p) => [p.id, ...p.tabs.map((t) => t.id)]);
  if (new Set(ids).size !== ids.length) return defaultLayout();
  if (!panes.some((p) => p.id === focus)) return defaultLayout();
  const fractions = widths as unknown[];
  if (
    !fractions.every(
      (w) => typeof w === "number" && Number.isFinite(w) && w >= MIN_WIDTH,
    ) ||
    Math.abs((fractions as number[]).reduce((s, w) => s + w, 0) - 1) > 0.001
  ) {
    return defaultLayout();
  }
  return normalize({
    version: 1,
    panes,
    focus: focus as string,
    widths: fractions as number[],
    seq: seq as number,
  });
}
