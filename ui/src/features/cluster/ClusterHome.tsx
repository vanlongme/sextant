import { Button } from "../../design";
import type { ClusterInfo } from "../../ipc/generated/ClusterInfo";
import { useClusterState } from "../../stores/clusters";
import { useClusterContext } from "./ClusterLayout";
import styles from "./ClusterScreen.module.css";

/** The content of a connected cluster. It is the Overview page of the sidebar. */
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

/** The index route of a connected cluster. */
export function ClusterOverview() {
  const { clusterId, busy, onDisconnect } = useClusterContext();
  const state = useClusterState(clusterId);
  if (state.status !== "connected") return null;
  return (
    <ClusterHome info={state.info} busy={busy} onDisconnect={onDisconnect} />
  );
}
