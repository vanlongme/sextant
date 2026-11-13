import type { ClusterInfo } from "../../ipc/generated/ClusterInfo";
import { PODS } from "../../kinds/refs";
import { useResourceList } from "../../stores/resources";
import { EventList } from "./EventsView";
import { useNodeReadiness } from "./paneData";
import styles from "./views.module.css";

const UNKNOWN = "—";

function Stat(props: {
  label: string;
  value: string | number;
  unit?: string;
  testId: string;
}) {
  return (
    <div className={styles.stat} data-testid={props.testId}>
      <p className={styles.statLabel}>{props.label}</p>
      <p className={styles.statValue}>
        {props.value}
        {props.unit ? (
          <span className={styles.statUnit}> {props.unit}</span>
        ) : null}
      </p>
    </div>
  );
}

/** Stat tiles, then the Warning events of the last hour (spec E §15.5). */
export function OverviewView(props: { clusterId: string; info: ClusterInfo }) {
  const { clusterId, info } = props;
  const nodes = useNodeReadiness(clusterId, true);
  const pods = useResourceList(clusterId, PODS);
  const running = pods.loading
    ? null
    : pods.items.filter((p) => p.status?.phase === "Running").length;

  return (
    <div className={styles.view} data-testid="workspace-overview">
      <div className={styles.stats}>
        <Stat
          label="Version"
          value={info.version}
          unit={info.distribution}
          testId="workspace-stat-version"
        />
        <Stat
          label="Nodes"
          value={nodes ? nodes.ready : UNKNOWN}
          unit={nodes ? `of ${nodes.total} ready` : undefined}
          testId="workspace-stat-nodes"
        />
        <Stat
          label="Pods"
          value={running ?? UNKNOWN}
          unit={running === null ? undefined : "running"}
          testId="workspace-stat-pods"
        />
        <Stat
          label="Namespaces"
          value={info.namespaces.length}
          testId="workspace-stat-namespaces"
        />
      </div>
      <h3 className={styles.sectionTitle}>Warnings</h3>
      <EventList
        clusterId={clusterId}
        limit={20}
        warnings
        empty="No warnings in the last hour."
        testId="workspace-warnings"
      />
    </div>
  );
}
