import { useEffect } from "react";
import { Outlet, useNavigate } from "react-router";
import { useCatalog } from "../stores/catalog";
import { Hotbar } from "./Hotbar";
import { installHistoryShortcuts } from "./history";
import styles from "./Shell.module.css";
import { StatusBar } from "./StatusBar";

export function Shell() {
  const init = useCatalog((s) => s.init);

  useEffect(() => {
    void init();
  }, [init]);

  const navigate = useNavigate();
  useEffect(() => installHistoryShortcuts((d) => void navigate(d)), [navigate]);

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
