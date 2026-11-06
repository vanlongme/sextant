import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { clusterStatus } from "../../app/clusterStatus";
import { Badge, EmptyState, Spinner } from "../../design";
import { useCatalog } from "../../stores/catalog";
import { useClusterState, useConnect } from "../../stores/clusters";
import { ClusterLayout } from "./ClusterLayout";
import styles from "./ClusterScreen.module.css";
import { ConnectionPanel } from "./ConnectionPanel";

function ClusterView({ id, name }: { id: string; name: string }) {
  const state = useClusterState(id);
  const { connect, disconnect, busy } = useConnect(id);
  const status = clusterStatus(state);
  // One automatic connect per mount, and none after the user disconnects.
  const autoDone = useRef(false);
  const [userDisconnected, setUserDisconnected] = useState(false);

  useEffect(() => {
    if (autoDone.current || state.status !== "disconnected") return;
    autoDone.current = true;
    void connect();
  }, [state.status, connect]);

  function userDisconnect(): void {
    autoDone.current = true;
    setUserDisconnected(true);
    void disconnect();
  }

  return (
    <div className={styles.screen}>
      <div className={styles.header}>
        <h2 className={styles.name}>{name}</h2>
        <span data-testid="connection-status">
          <Badge tone={status.tone}>{status.label}</Badge>
        </span>
      </div>
      {state.status === "connected" ? (
        <ClusterLayout
          clusterId={id}
          busy={busy}
          onDisconnect={userDisconnect}
        />
      ) : (
        <ConnectionPanel
          id={id}
          state={state}
          busy={busy}
          reconnect={userDisconnected}
          onConnect={() => void connect()}
          onDisconnect={userDisconnect}
        />
      )}
    </div>
  );
}

export function ClusterScreen() {
  const { id = "" } = useParams();
  const cluster = useCatalog((s) => s.clusters.find((c) => c.id === id));
  const loading = useCatalog((s) => s.loading);

  if (!cluster) {
    if (loading) {
      return (
        <div className={styles.screen}>
          <Spinner label="Loading" />
        </div>
      );
    }
    return (
      <EmptyState
        title="Cluster not found"
        body="This cluster is not in the catalog. It may have been removed."
        action={<Link to="/catalog">Back to the catalog</Link>}
      />
    );
  }
  return <ClusterView key={id} id={id} name={cluster.name} />;
}
