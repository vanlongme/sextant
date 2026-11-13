import { useDndContext, useDroppable } from "@dnd-kit/core";
import { useWorkspace } from "../../stores/workspace";
import { tabLabel, useClusterName } from "./clusters";
import { targetId } from "./drag";
import { findTab, MAX_PANES } from "./layout";
import styles from "./WorkspaceScreen.module.css";

function Zone(props: { id: string; label: string; testId: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: props.id });
  return (
    <div
      ref={setNodeRef}
      className={styles.zone}
      data-over={isOver}
      data-testid={props.testId}
    >
      {props.label}
    </div>
  );
}

/**
 * While a tab is dragged, a pane's body offers "Move to this pane" and, with fewer
 * than 3 panes, "Open to the side" (spec E §15.3).
 */
export function DropZones(props: { paneId: string }) {
  const { active } = useDndContext();
  const room = useWorkspace((s) => s.layout.panes.length < MAX_PANES);
  if (!active) return null;
  return (
    <div className={styles.zones}>
      <Zone
        id={targetId({ kind: "here", paneId: props.paneId })}
        label="Move to this pane"
        testId="workspace-drop-here"
      />
      {room ? (
        <Zone
          id={targetId({ kind: "side", paneId: props.paneId })}
          label="Open to the side"
          testId="workspace-drop-side"
        />
      ) : null}
    </div>
  );
}

/** What follows the pointer while a tab is dragged: its label. */
export function DragGhost(props: { tabId: string }) {
  const tab = useWorkspace((s) => findTab(s.layout, props.tabId)?.tab ?? null);
  const name = useClusterName(tab?.clusterId ?? "");
  if (!tab) return null;
  return (
    <div className={styles.ghost} data-testid="workspace-drag-ghost">
      {tabLabel(name, tab.view)}
    </div>
  );
}
