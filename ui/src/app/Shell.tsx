import { useEffect } from "react";
import { Outlet } from "react-router";
import { useCatalog } from "../stores/catalog";
import { Hotbar } from "./Hotbar";
import styles from "./Shell.module.css";
import { StatusBar } from "./StatusBar";

export function Shell() {
  const init = useCatalog((s) => s.init);

  useEffect(() => {
    void init();
  }, [init]);

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
