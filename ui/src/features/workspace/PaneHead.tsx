import { Maximize2 } from "lucide-react";
import { useNavigate } from "react-router";
import { clusterStatus } from "../../app/clusterStatus";
import { Badge, IconButton, Segmented } from "../../design";
import { useWorkspace } from "../../stores/workspace";
import { useClusterName, useWorkspaceClusterState } from "./clusters";
import { VIEW_LABELS, VIEWS, type WorkspaceTab } from "./layout";
import {
  fullScreenPath,
  paneMeta,
  useNodeReadiness,
  useTabNamespace,
} from "./paneData";
import styles from "./WorkspaceScreen.module.css";

const VIEW_OPTIONS = VIEWS.map((view) => ({
  value: view,
  label: VIEW_LABELS[view],
}));

/**
 * The head of a pane: the cluster's name and status, the view picker, the way to
 * the full cluster screen, and a meta line (spec E §15.4).
 */
export function PaneHead(props: { tab: WorkspaceTab }) {
  const { tab } = props;
  const name = useClusterName(tab.clusterId);
  const state = useWorkspaceClusterState(tab.clusterId);
  const status = clusterStatus(state);
  const info = state.status === "connected" ? state.info : null;
  const nodes = useNodeReadiness(tab.clusterId, info !== null);
  const namespace = useTabNamespace(tab);
  const dispatch = useWorkspace((s) => s.dispatch);
  const navigate = useNavigate();
  const meta = paneMeta({ info, nodes, namespace });

  return (
    <header className={styles.paneHead}>
      <div className={styles.paneTitleRow}>
        <h2 className={styles.paneName}>{name}</h2>
        <Badge tone={status.tone}>{status.label}</Badge>
        <span className={styles.grow} />
        <Segmented
          label="View"
          size="sm"
          value={tab.view}
          options={VIEW_OPTIONS}
          testId="workspace-view"
          onChange={(view) =>
            dispatch({ type: "setView", tabId: tab.id, view })
          }
        />
        <IconButton
          label="Open the full cluster screen"
          icon={<Maximize2 size={14} aria-hidden="true" />}
          data-testid="workspace-open-full"
          onClick={() => navigate(fullScreenPath(tab))}
        />
      </div>
      {meta ? (
        <p className={styles.paneMeta} data-testid="workspace-meta">
          {meta}
        </p>
      ) : null}
    </header>
  );
}
