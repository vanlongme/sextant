import { useEffect, useRef } from "react";
import type { SessionDockTab } from "../../stores/dock";
import { mountView, showView, unmountView } from "./sessions";
import styles from "./TerminalTab.module.css";
import { TerminalToolbar } from "./TerminalToolbar";

/**
 * A terminal session's tab: the toolbar over the terminal area. The session lives in
 * the registry, so it keeps running while this component is unmounted.
 */
export function TerminalTab({
  tab,
  shown,
}: {
  tab: SessionDockTab;
  /** Whether the tab's panel is visible: active and the dock not minimized. */
  shown: boolean;
}) {
  const area = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the registry reads the tab's latest state from the dock, so a new `tab` object needs no remount.
  useEffect(() => {
    const element = area.current;
    if (!element) return;
    mountView(tab, element);
    return () => unmountView(tab.id);
  }, [tab.id]);

  useEffect(() => {
    if (shown) showView(tab.id);
  }, [shown, tab.id]);

  return (
    <div className={styles.root} data-testid="terminal-tab">
      <TerminalToolbar tab={tab} />
      <div ref={area} className={styles.view} data-testid="terminal-view" />
    </div>
  );
}
