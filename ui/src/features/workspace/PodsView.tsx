import { useMemo } from "react";
import { useNavigate } from "react-router";
import {
  Badge,
  type Column,
  DataTable,
  Select,
  Spinner,
  type TableColumn,
  useNow,
  VirtualTable,
} from "../../design";
import type { ClusterInfo } from "../../ipc/generated/ClusterInfo";
import { formatAge, type KubeObject } from "../../kinds/objects";
import { PODS } from "../../kinds/refs";
import { podStatus, podSummary } from "../../kinds/workloads/pod";
import { useResourceList } from "../../stores/resources";
import { useWorkspace } from "../../stores/workspace";
import type { WorkspaceTab } from "./layout";
import { useTabNamespace } from "./paneData";
import { podCount, podDrawerPath, podImage } from "./views";
import styles from "./views.module.css";

/** Past this many rows the table is virtualised (spec E §15.5). */
const VIRTUAL_FROM = 201;
/** Radix Select needs a value for "All namespaces"; no namespace is named "*". */
const ALL = "*";

/** Watched Pod rows keep each container's image (spec E §4.9). */
function columns(
  now: number,
): (Column<KubeObject> & TableColumn<KubeObject>)[] {
  return [
    {
      id: "name",
      header: "Name",
      width: "minmax(140px, 2fr)",
      render: (p) => p.metadata.name,
    },
    {
      id: "status",
      header: "Status",
      width: "130px",
      render: (p) => {
        const status = podStatus(p);
        return <Badge tone={status.tone}>{status.label}</Badge>;
      },
    },
    {
      id: "restarts",
      header: "Restarts",
      width: "80px",
      render: (p) => podSummary(p).restarts,
    },
    {
      id: "image",
      header: "Image",
      width: "minmax(120px, 1fr)",
      render: (p) => <span className={styles.mono}>{podImage(p) || "—"}</span>,
    },
    {
      id: "age",
      header: "Age",
      width: "70px",
      render: (p) => formatAge(p.metadata.creationTimestamp, now),
    },
  ];
}

/**
 * The Pods of the tab's cluster in one namespace or all of them, with a namespace
 * picker and a count (spec E §15.5). A row opens the Pod's drawer in the full
 * cluster screen.
 */
export function PodsView(props: { tab: WorkspaceTab; info: ClusterInfo }) {
  const { tab, info } = props;
  const list = useResourceList(tab.clusterId, PODS);
  const namespace = useTabNamespace(tab);
  const setNamespace = useWorkspace((s) => s.setNamespace);
  const navigate = useNavigate();
  const now = useNow();
  const pods = useMemo(
    () =>
      namespace
        ? list.items.filter((p) => p.metadata.namespace === namespace)
        : list.items,
    [list.items, namespace],
  );
  const cols = columns(now);
  const open = (pod: KubeObject) => navigate(podDrawerPath(tab.clusterId, pod));
  const options = [
    { value: ALL, label: "All namespaces" },
    ...info.namespaces.map((ns) => ({ value: ns, label: ns })),
  ];

  return (
    <div className={styles.view} data-testid="workspace-pods">
      <div className={styles.toolbar}>
        <Select
          label="Namespace"
          hideLabel
          value={namespace ?? ALL}
          options={options}
          testId="workspace-namespace"
          onChange={(value) =>
            setNamespace(tab.id, value === ALL ? null : value)
          }
        />
        <span className={styles.count} data-testid="workspace-pod-count">
          {podCount(pods.length)}
        </span>
      </div>
      {list.loading ? (
        <div className={styles.loading}>
          <Spinner label="Loading" />
        </div>
      ) : list.message !== null && pods.length === 0 ? (
        <p className={styles.empty}>{list.message}</p>
      ) : pods.length === 0 ? (
        <p className={styles.empty}>
          {namespace ? `No Pods in ${namespace}.` : "No Pods in this cluster."}
        </p>
      ) : pods.length >= VIRTUAL_FROM ? (
        <div className={styles.table}>
          <VirtualTable
            rows={pods}
            columns={cols}
            rowKey={(p) => p.metadata.uid ?? p.metadata.name}
            rowTestId={() => "workspace-pod"}
            onRowClick={open}
          />
        </div>
      ) : (
        <div className={styles.table}>
          <DataTable
            rows={pods}
            columns={cols}
            rowKey={(p) => p.metadata.uid ?? p.metadata.name}
            rowTestId={() => "workspace-pod"}
            onRowClick={open}
          />
        </div>
      )}
    </div>
  );
}
