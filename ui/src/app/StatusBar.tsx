import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useState } from "react";
import { runningText } from "../features/portForward/forwardText";
import { useCatalog } from "../stores/catalog";
import { runningCount, usePortForwards } from "../stores/portForwards";
import styles from "./Shell.module.css";

export function StatusBar() {
  const connected = useCatalog(
    (s) => s.clusters.filter((c) => c.state.status === "connected").length,
  );
  const forwards = runningText(
    usePortForwards((s) => runningCount(s.forwards)),
  );
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    getVersion().then(setVersion, () => setVersion(null));
  }, []);

  return (
    <footer className={styles.status} data-testid="status-bar">
      <span className={styles.statusLine}>{connected} connected</span>
      {forwards ? (
        <span className={styles.statusLine} data-testid="status-port-forwards">
          {forwards}
        </span>
      ) : null}
      <span>{version ? `SkoposIDE ${version}` : "SkoposIDE"}</span>
    </footer>
  );
}
