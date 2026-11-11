import { useNavigate } from "react-router";
import { Button } from "../../design";
import type { ClusterInfo } from "../../ipc/generated/ClusterInfo";
import { useCatalog } from "../../stores/catalog";
import { useClusterState } from "../../stores/clusters";
import { OverviewMetrics } from "../metrics/OverviewMetrics";
import { settingsPath } from "../settings/paths";
import { useClusterContext } from "./ClusterLayout";
import styles from "./ClusterScreen.module.css";

/** The content of a connected cluster. It is the Overview page of the sidebar. */
export function ClusterHome(props: {
  clusterId: string;
  clusterName: string;
  info: ClusterInfo;
}) {
  const { clusterId, info } = props;
  const navigate = useNavigate();
  return (
    <section className={`${styles.panel} ${styles.home}`} aria-label="Cluster">
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
      {info.namespacesRestricted ? (
        <div className={styles.warnRow}>
          <p
            className={styles.warn}
            role="status"
            data-testid="cluster-namespaces-warning"
          >
            You may not list this cluster's namespaces, so only these are used:{" "}
            {info.namespaces.join(", ")}.
          </p>
          <Button
            variant="secondary"
            size="sm"
            data-testid="cluster-namespaces-settings"
            onClick={() => navigate(settingsPath(clusterId))}
          >
            Cluster settings
          </Button>
        </div>
      ) : null}
      <OverviewMetrics
        clusterId={clusterId}
        clusterName={props.clusterName}
        info={info}
      />
    </section>
  );
}

/** The index route of a connected cluster. */
export function ClusterOverview() {
  const { clusterId } = useClusterContext();
  const state = useClusterState(clusterId);
  const name = useCatalog(
    (s) => s.clusters.find((c) => c.id === clusterId)?.name ?? clusterId,
  );
  if (state.status !== "connected") return null;
  return (
    <ClusterHome clusterId={clusterId} clusterName={name} info={state.info} />
  );
}
