import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useState } from "react";
import { useCatalog } from "../stores/catalog";
import styles from "./Shell.module.css";

export function StatusBar() {
  const connected = useCatalog(
    (s) => s.clusters.filter((c) => c.state.status === "connected").length,
  );
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    getVersion().then(setVersion, () => setVersion(null));
  }, []);

  return (
    <footer className={styles.status} data-testid="status-bar">
      <span>{connected} connected</span>
      <span>{version ? `SkoposIDE ${version}` : "SkoposIDE"}</span>
    </footer>
  );
}
