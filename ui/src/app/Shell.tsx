import { useEffect, useRef } from "react";
import { Outlet, useNavigate } from "react-router";
import { useCatalog } from "../stores/catalog";
import { useShell } from "../stores/shell";
import { runCommand, useCommandContext } from "./commands";
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

  return (
    <div className={styles.shell}>
      <Hotbar />
      <main className={styles.content}>
        <Outlet />
      </main>
      <StatusBar />
    </div>
  );
}
