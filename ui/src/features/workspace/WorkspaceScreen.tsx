import { RotateCcw } from "lucide-react";
import { Fragment, useEffect, useRef } from "react";
import { IS_MAC, matchesShortcut } from "../../app/shortcuts";
import { Button, Spinner } from "../../design";
import { restoreWorkspace, useWorkspace } from "../../stores/workspace";
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

/** Several clusters side by side, at /workspace (spec E §15). */
export function WorkspaceScreen() {
  const restored = useWorkspace((s) => s.restored);
  const layout = useWorkspace((s) => s.layout);
  const dispatch = useWorkspace((s) => s.dispatch);
  const root = useRef<HTMLDivElement>(null);

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
        </>
      ) : (
        <div className={styles.loading}>
          <Spinner label="Loading" />
        </div>
      )}
    </div>
  );
}
