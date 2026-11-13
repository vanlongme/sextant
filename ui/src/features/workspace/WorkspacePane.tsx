import { useEffect, useRef } from "react";
import { useWorkspace } from "../../stores/workspace";
import { tabLabel, useClusterName } from "./clusters";
import { DropZones } from "./DropZones";
import { activeTab, type WorkspacePane as Pane } from "./layout";
import { PaneBody } from "./PaneBody";
import { PaneHead } from "./PaneHead";
import { TabStrip } from "./TabStrip";
import styles from "./WorkspaceScreen.module.css";

function EmptyPane() {
  return (
    <div className={styles.empty} data-testid="workspace-empty">
      <p className={styles.emptyTitle}>
        Pick a cluster in the hotbar to open it here
      </p>
      <p className={styles.emptyBody}>
        Shift-click opens it in a new pane to the side.
      </p>
    </div>
  );
}

/** "Pane 1 of 2: prod · Pods", or "Pane 1 of 2" while it is empty. */
function usePaneLabel(pane: Pane, index: number, count: number): string {
  const tab = activeTab(pane);
  const name = useClusterName(tab?.clusterId ?? "");
  const where = `Pane ${index + 1} of ${count}`;
  return tab ? `${where}: ${tabLabel(name, tab.view)}` : where;
}

/**
 * One pane of the Workspace. A pointer press or the focus inside it makes it the
 * focused pane (spec E §15.4).
 */
export function WorkspacePane(props: {
  pane: Pane;
  index: number;
  count: number;
  width: number;
}) {
  const { pane, index } = props;
  const focused = useWorkspace((s) => s.layout.focus === pane.id);
  const label = usePaneLabel(pane, index, props.count);
  const ref = useRef<HTMLElement>(null);
  const tab = activeTab(pane);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const focus = () =>
      useWorkspace.getState().dispatch({ type: "focus", paneId: pane.id });
    element.addEventListener("pointerdown", focus, true);
    element.addEventListener("focusin", focus);
    return () => {
      element.removeEventListener("pointerdown", focus, true);
      element.removeEventListener("focusin", focus);
    };
  }, [pane.id]);

  return (
    <section
      ref={ref}
      className={styles.pane}
      style={{ flexGrow: props.width }}
      aria-label={label}
      data-testid="workspace-pane"
      data-pane={index}
      data-focused={focused}
    >
      {tab ? (
        <>
          <TabStrip pane={pane} index={index} />
          <PaneHead key={tab.id} tab={tab} />
          <div className={styles.body}>
            <PaneBody key={tab.id} tab={tab} />
            <DropZones paneId={pane.id} />
          </div>
        </>
      ) : (
        <EmptyPane />
      )}
    </section>
  );
}
