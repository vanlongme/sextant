import { Plug, RefreshCw } from "lucide-react";
import { Link } from "react-router";
import { Button, Spinner } from "../../design";
import { connectCluster } from "../../stores/clusters";
import { useClusterName, useWorkspaceClusterState } from "./clusters";
import { EventsView } from "./EventsView";
import type { WorkspaceTab } from "./layout";
import { OverviewView } from "./OverviewView";
import { PodsView } from "./PodsView";
import { useConnectOnActivate } from "./paneData";
import styles from "./WorkspaceScreen.module.css";

function Failed(props: { clusterId: string; message: string }) {
  return (
    <div className={styles.failed} data-testid="workspace-failed">
      <h3 className={styles.failedTitle}>Cannot reach the cluster</h3>
      <p className={styles.failedMessage}>{props.message}</p>
      <p className={styles.failedHint}>
        Check the network or VPN and reconnect. The other panes keep their
        connections.
      </p>
      <div className={styles.failedActions}>
        <Button
          variant="primary"
          size="sm"
          data-testid="workspace-reconnect"
          onClick={() => void connectCluster(props.clusterId)}
        >
          <RefreshCw size={14} aria-hidden="true" />
          Reconnect
        </Button>
        <Link
          className={styles.link}
          to={`/cluster/${encodeURIComponent(props.clusterId)}`}
          data-testid="workspace-connection-log"
        >
          Connection log
        </Link>
      </div>
    </div>
  );
}

/**
 * The body of a pane for its active tab: it connects the cluster when the tab
 * becomes active, and shows the connection's state until the cluster is
 * connected (spec E §15.6). Closing a tab never disconnects.
 */
export function PaneBody(props: { tab: WorkspaceTab }) {
  const { tab } = props;
  const name = useClusterName(tab.clusterId);
  const state = useWorkspaceClusterState(tab.clusterId);
  useConnectOnActivate(tab.clusterId);

  if (state.status === "connecting") {
    return (
      <div className={styles.state} data-testid="workspace-connecting">
        <Spinner label={`Connecting to ${name}…`} />
      </div>
    );
  }
  if (state.status === "failed") {
    return <Failed clusterId={tab.clusterId} message={state.message} />;
  }
  if (state.status === "disconnected") {
    return (
      <div className={styles.state}>
        <Button
          variant="primary"
          size="sm"
          data-testid="workspace-connect"
          onClick={() => void connectCluster(tab.clusterId)}
        >
          <Plug size={14} aria-hidden="true" />
          Connect
        </Button>
      </div>
    );
  }
  if (tab.view === "overview") {
    return <OverviewView clusterId={tab.clusterId} info={state.info} />;
  }
  if (tab.view === "pods") return <PodsView tab={tab} info={state.info} />;
  return <EventsView clusterId={tab.clusterId} />;
}
