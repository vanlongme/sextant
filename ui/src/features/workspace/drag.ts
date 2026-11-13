import type { CollisionDetection } from "@dnd-kit/core";
import { pointerWithin } from "@dnd-kit/core";
import {
  findTab,
  MAX_PANES,
  type WorkspaceAction,
  type WorkspaceLayout,
} from "./layout";

/**
 * Where a dragged tab can land (spec E §15.3): on a tab, on a pane's strip, or on
 * one of the two drop zones of a pane's body.
 */
export type DropTarget =
  | { kind: "tab"; tabId: string }
  | { kind: "strip"; paneId: string }
  | { kind: "here"; paneId: string }
  | { kind: "side"; paneId: string };

/** The dnd-kit id of a target: "tab:t1", "strip:p1", "here:p1", "side:p1". */
export function targetId(target: DropTarget): string {
  return target.kind === "tab"
    ? `tab:${target.tabId}`
    : `${target.kind}:${target.paneId}`;
}

export function parseTarget(id: string): DropTarget | null {
  const at = id.indexOf(":");
  const kind = id.slice(0, at);
  const rest = id.slice(at + 1);
  if (at <= 0 || rest === "") return null;
  if (kind === "tab") return { kind, tabId: rest };
  if (kind === "strip" || kind === "here" || kind === "side") {
    return { kind, paneId: rest };
  }
  return null;
}

/**
 * The layout change for dropping a tab on a target, or null when there is none. On
 * a tab it takes that tab's place; on a strip or "Move to this pane" it goes last;
 * "Open to the side" moves it to a new pane beside that one.
 */
export function dropAction(
  layout: WorkspaceLayout,
  tabId: string,
  target: DropTarget,
): WorkspaceAction | null {
  const from = findTab(layout, tabId);
  if (!from) return null;
  if (target.kind === "tab") {
    if (target.tabId === tabId) return null;
    const over = findTab(layout, target.tabId);
    if (!over) return null;
    // The reducer counts the index before the tab leaves its own pane.
    const later =
      over.pane.id === from.pane.id && from.tabIndex < over.tabIndex;
    return {
      type: "move",
      tabId,
      paneId: over.pane.id,
      index: later ? over.tabIndex + 1 : over.tabIndex,
    };
  }
  const pane = layout.panes.find((p) => p.id === target.paneId);
  if (!pane) return null;
  if (target.kind === "side") {
    if (layout.panes.length >= MAX_PANES) return null;
    return { type: "moveToNewPane", tabId, paneId: pane.id };
  }
  return { type: "move", tabId, paneId: pane.id, index: pane.tabs.length };
}

const RANK: Record<DropTarget["kind"], number> = {
  tab: 0,
  here: 1,
  side: 1,
  strip: 2,
};

/** Under the pointer only: a tab before a drop zone, and a zone before a strip. */
export const collide: CollisionDetection = (args) =>
  pointerWithin(args).sort((a, b) => {
    const ra = RANK[parseTarget(String(a.id))?.kind ?? "strip"];
    const rb = RANK[parseTarget(String(b.id))?.kind ?? "strip"];
    return ra - rb;
  });
