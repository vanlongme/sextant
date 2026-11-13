import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { RotateCcw } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { IS_MAC, matchesShortcut } from "../../app/shortcuts";
import { Button, Spinner } from "../../design";
import { restoreWorkspace, useWorkspace } from "../../stores/workspace";
import { DragGhost } from "./DropZones";
import { collide, dropAction, parseTarget } from "./drag";
import { activeTab, focusedPane, layoutSummary } from "./layout";
import { Splitter } from "./Splitter";
import { WorkspacePane } from "./WorkspacePane";
import styles from "./WorkspaceScreen.module.css";

function typingIn(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.closest("input, textarea, select") !== null)
  );
}

/**
 * Ctrl+\ (⌘\ on macOS) opens the focused pane's active tab to the side, while the
 * focus is in the Workspace and not in a field (spec E §15.7).
 */
function useSplitKey(root: React.RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    function onKey(event: KeyboardEvent): void {
      if (!matchesShortcut("workspaceSplit", event, IS_MAC)) return;
      if (typingIn(event.target)) return;
      const { layout, dispatch } = useWorkspace.getState();
      const tab = activeTab(focusedPane(layout));
      if (!tab) return;
      event.preventDefault();
      dispatch({ type: "split", tabId: tab.id });
    }
    element.addEventListener("keydown", onKey);
    return () => element.removeEventListener("keydown", onKey);
  }, [root]);
}

/** The id of the tab a dnd-kit id names, or null. */
function draggedTab(id: string | number): string | null {
  const target = parseTarget(String(id));
  return target?.kind === "tab" ? target.tabId : null;
}

/**
 * Tabs drag with the pointer, as the hotbar's tiles do; Esc cancels (spec E §15.3).
 * The tab strips and drop zones register as targets inside.
 */
function useTabDrag() {
  const [dragging, setDragging] = useState<string | null>(null);
  const sensors = useSensors(
    // A small threshold, so a plain click still picks the tab.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );
  function onDragStart({ active }: DragStartEvent): void {
    setDragging(draggedTab(active.id));
  }
  function onDragEnd({ active, over }: DragEndEvent): void {
    setDragging(null);
    const tabId = draggedTab(active.id);
    const target = over ? parseTarget(String(over.id)) : null;
    if (!tabId || !target) return;
    const { layout, dispatch } = useWorkspace.getState();
    const action = dropAction(layout, tabId, target);
    if (action) dispatch(action);
  }
  return {
    dragging,
    context: {
      sensors,
      collisionDetection: collide,
      onDragStart,
      onDragEnd,
      onDragCancel: () => setDragging(null),
    },
  };
}

/** Several clusters side by side, at /workspace (spec E §15). */
export function WorkspaceScreen() {
  const restored = useWorkspace((s) => s.restored);
  const layout = useWorkspace((s) => s.layout);
  const dispatch = useWorkspace((s) => s.dispatch);
  const root = useRef<HTMLDivElement>(null);
  const drag = useTabDrag();

  useEffect(() => {
    void restoreWorkspace();
  }, []);
  useSplitKey(root);

  return (
    <div ref={root} className={styles.page} data-testid="workspace-page">
      {restored ? (
        <>
          <header className={styles.head}>
            <h1 className={styles.title}>Workspace</h1>
            <span className={styles.summary} data-testid="workspace-summary">
              {layoutSummary(layout)}
            </span>
            <Button
              variant="secondary"
              size="sm"
              data-testid="workspace-reset"
              onClick={() => dispatch({ type: "reset" })}
            >
              <RotateCcw size={14} aria-hidden="true" />
              Reset layout
            </Button>
          </header>
          <DndContext {...drag.context}>
            <div className={styles.panes}>
              {layout.panes.map((pane, index) => (
                <Fragment key={pane.id}>
                  <WorkspacePane
                    pane={pane}
                    index={index}
                    count={layout.panes.length}
                    width={layout.widths[index]}
                  />
                  {index < layout.panes.length - 1 ? (
                    <Splitter index={index} width={layout.widths[index]} />
                  ) : null}
                </Fragment>
              ))}
            </div>
            <DragOverlay>
              {drag.dragging ? <DragGhost tabId={drag.dragging} /> : null}
            </DragOverlay>
          </DndContext>
        </>
      ) : (
        <div className={styles.loading}>
          <Spinner label="Loading" />
        </div>
      )}
    </div>
  );
}
