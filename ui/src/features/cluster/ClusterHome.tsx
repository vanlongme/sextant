import { Button } from "../../design";
import type { ClusterInfo } from "../../ipc/generated/ClusterInfo";
import styles from "./ClusterScreen.module.css";

/** The content of a connected cluster. Navigation replaces it in Phase 2. */
export function ClusterHome(props: {
  info: ClusterInfo;
  busy: boolean;
  onDisconnect(): void;
}) {
  const { info } = props;
  return (
    <section className={styles.panel} aria-label="Cluster">
      <dl className={styles.facts}>
        <dt>Version</dt>
        <dd data-testid="cluster-info-version">{info.version}</dd>
        <dt>Distribution</dt>
        <dd data-testid="cluster-info-distribution">{info.distribution}</dd>
        <dt>Nodes</dt>
        <dd data-testid="cluster-info-nodes">{info.nodeCount ?? "Unknown"}</dd>
        <dt>Namespaces</dt>
        <dd data-testid="cluster-info-namespaces">
          {info.namespacesRestricted ? "Restricted" : info.namespaces.length}
        </dd>
      </dl>
      <div className={styles.actions}>
        <Button
          disabled={props.busy}
          data-testid="cluster-disconnect"
          onClick={props.onDisconnect}
        >
          Disconnect
        </Button>
      </div>
    </section>
  );
}
