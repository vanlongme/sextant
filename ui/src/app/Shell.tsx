import { useEffect, useRef } from "react";
import { Outlet, useNavigate } from "react-router";
import { AboutDialog } from "../features/about/AboutDialog";
import { CommandPalette } from "../features/palette/CommandPalette";
import { ShortcutsDialog } from "../features/shortcuts/ShortcutsDialog";
import { events } from "../ipc/events";
import { useCatalog } from "../stores/catalog";
import { useShell } from "../stores/shell";
import { AppHeader } from "./AppHeader";
import { runCommand, runMenuCommand, useCommandContext } from "./commands";
import { Hotbar } from "./Hotbar";
import { installHistoryShortcuts } from "./history";
import styles from "./Shell.module.css";
import { StatusBar } from "./StatusBar";
import { installShellKeys } from "./shellKeys";
import { IS_MAC } from "./shortcuts";

export function Shell() {
  const init = useCatalog((s) => s.init);

  useEffect(() => {
    void init();
  }, [init]);

  const navigate = useNavigate();
  useEffect(() => installHistoryShortcuts((d) => void navigate(d)), [navigate]);

  // The listeners are installed once and read the latest context through a ref.
  const context = useCommandContext();
  const contextRef = useRef(context);
  useEffect(() => {
    contextRef.current = context;
  }, [context]);

  useEffect(
    () =>
      installShellKeys(
        {
          palette: () => useShell.getState().open("palette"),
          shortcuts: () => useShell.getState().open("shortcuts"),
          preferences: () => runCommand("preferences", contextRef.current),
        },
        IS_MAC,
      ),
    [],
  );

  // The macOS menu's app items (spec C §9.2). Elsewhere nothing emits the event.
  useEffect(() => {
    const listening = events.onMenuCommand(({ id }) =>
      runMenuCommand(id, contextRef.current),
    );
    return () => {
      // A failed unlisten at unmount has nothing to undo, so it is not reported.
      void listening.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  return (
    <div className={styles.shell}>
      <Hotbar />
      <div className={styles.column}>
        <AppHeader />
        <main className={styles.content}>
          <Outlet />
        </main>
      </div>
      <StatusBar />
      <CommandPalette />
      <ShortcutsDialog />
      <AboutDialog />
    </div>
  );
}
