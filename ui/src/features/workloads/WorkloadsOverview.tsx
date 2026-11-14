import { type ReactNode, useMemo } from "react";
import { Link } from "react-router";
import { Badge, type Column, DataTable, Spinner, useNow } from "../../design";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import {
  eventLastSeen,
  eventObjectText,
  eventStatus,
} from "../../kinds/cluster/cluster";
import { resourcePath } from "../../kinds/nav";
import { formatAge, type KubeObject, objectKey } from "../../kinds/objects";
import { useClusterState } from "../../stores/clusters";
import { findResource, useResourceList } from "../../stores/resources";
import { useUiState } from "../../stores/uiState";
import { useClusterContext } from "../cluster/ClusterLayout";
import {
  NamespaceFilter,
  namespaceFilterKey,
} from "../resources/NamespaceFilter";
import {
  type Discovery,
  type KindRow,
  kindRow,
  latestEvents,
  listedResource,
  listView,
  WORKLOAD_KINDS,
  type WorkloadCounts,
  type WorkloadKind,
} from "./counts";
import styles from "./WorkloadsOverview.module.css";

/** What the app shows for a value it cannot know. */
const UNAVAILABLE = "—";

/** As many as a compact event list shows; the Events screen has the rest. */
const RECENT_EVENTS = 10;

const [
  PODS,
  DEPLOYMENTS,
  DAEMONSETS,
  STATEFULSETS,
  REPLICASETS,
  JOBS,
  CRONJOBS,
] = WORKLOAD_KINDS;

/** A kind's row, recounted only when its list, discovery or the namespaces change. */
function useKindRow(
  clusterId: string,
  resources: ApiResourceInfo[],
  discovery: Discovery,
  namespaces: string[],
  kind: WorkloadKind,
): { row: KindRow; namespaces: string[] } {
  const info = findResource(resources, kind.group, kind.plural);
  const list = useResourceList(clusterId, listedResource(info));
  const row = useMemo(
    () => kindRow(kind, info, discovery, list, namespaces),
    [kind, info, discovery, list, namespaces],
  );
  const found = useMemo(() => namespacesOf(list.items), [list.items]);
  return { row, namespaces: found };
}

function namespacesOf(objects: KubeObject[]): string[] {
  const found = new Set<string>();
  for (const o of objects) {
    if (o.metadata.namespace) found.add(o.metadata.namespace);
  }
  return [...found];
}

/** A count in the secondary colour, or the loading and unavailable states. */
function countCell(
  row: KindRow,
  value: (counts: WorkloadCounts) => ReactNode,
): ReactNode {
  if (row.state === "loading") return null;
  if (row.state === "unavailable") {
    return (
      <span className={styles.muted} title={row.reason}>
        {UNAVAILABLE}
      </span>
    );
  }
  return value(row.counts);
}

function kindColumns(clusterId: string): Column<KindRow>[] {
  const muted = (n: number) => <span className={styles.muted}>{n}</span>;
  return [
    {
      id: "kind",
      header: "Kind",
      render: (row) =>
        row.state === "unavailable" ? (
          row.kind.label
        ) : (
          <Link
            className={styles.link}
            to={resourcePath(clusterId, row.kind.group, row.kind.plural)}
          >
            {row.kind.label}
          </Link>
        ),
    },
    {
      id: "total",
      header: "Total",
      width: "88px",
      align: "end",
      render: (row) =>
        row.state === "loading" ? <Spinner /> : countCell(row, (c) => c.total),
    },
    {
      id: "healthy",
      header: "Healthy",
      width: "88px",
      align: "end",
      render: (row) => countCell(row, (c) => muted(c.healthy)),
    },
    {
      id: "pending",
      header: "Pending",
      width: "88px",
      align: "end",
      render: (row) => countCell(row, (c) => muted(c.pending)),
    },
    {
      id: "failing",
      header: "Failing",
      width: "88px",
      align: "end",
      render: (row) =>
        countCell(row, (c) =>
          c.failing > 0 ? <Badge tone="danger">{c.failing}</Badge> : muted(0),
        ),
    },
  ];
}

function eventColumns(now: number): Column<KubeObject>[] {
  const truncated = (text: string) => (
    <span className={styles.truncated} title={text}>
      {text}
    </span>
  );
  return [
    {
      id: "age",
      header: "Age",
      width: "72px",
      render: (e) => formatAge(eventLastSeen(e), now),
    },
    {
      id: "type",
      header: "Type",
      width: "96px",
      render: (e) => {
        const { label } = eventStatus(e);
        return (
          <Badge tone={label === "Warning" ? "warn" : "neutral"}>{label}</Badge>
        );
      },
    },
    {
      id: "object",
      header: "Object",
      width: "34%",
      render: (e) => truncated(eventObjectText(e)),
    },
    {
      id: "message",
      header: "Message",
      render: (e) => truncated(e.message ?? e.note ?? ""),
    },
  ];
}

function noEventsText(namespaces: string[]): string {
  if (namespaces.length === 0) return "No recent events.";
  const plural = namespaces.length > 1 ? "s" : "";
  return `No recent events in namespace${plural} ${namespaces.join(", ")}.`;
}

/**
 * The newest events in the chosen namespaces. It is a component of its own, so the
 * clock that ages the events re-renders only this table.
 */
function RecentEvents(props: {
  clusterId: string;
  info: ApiResourceInfo | undefined;
  discovery: Discovery;
  namespaces: string[];
}) {
  const { clusterId, info, discovery, namespaces } = props;
  const list = useResourceList(clusterId, listedResource(info));
  const now = useNow();
  const view = useMemo(
    () => listView("Events", info, discovery, list, namespaces),
    [info, discovery, list, namespaces],
  );
  const events = useMemo(
    () =>
      view.state === "ready" ? latestEvents(view.items, RECENT_EVENTS) : [],
    [view],
  );
  if (view.state === "loading") return <Spinner label="Loading events" />;
  if (view.state === "unavailable") {
    return (
      <p className={styles.muted} data-testid="workloads-events-status">
        {view.reason}
      </p>
    );
  }
  return (
    <div className={styles.table}>
      <DataTable
        rows={events}
        columns={eventColumns(now)}
        rowKey={objectKey}
        rowTestId={() => "workload-event"}
        label="Recent events"
        empty={<p className={styles.muted}>{noEventsText(namespaces)}</p>}
        testId="workloads-events"
      />
    </div>
  );
}

/**
 * The Workloads overview (F17): each workload kind counted by the status its list
 * shows, then the recent events, in the namespaces the lists are filtered to.
 */
export function WorkloadsOverview() {
  const { clusterId, resources, resourcesLoading, resourcesError } =
    useClusterContext();
  const [namespaces, setNamespaces] = useUiState<string[]>(
    namespaceFilterKey(clusterId),
    [],
  );
  const discovery = useMemo(
    () => ({ loading: resourcesLoading, error: resourcesError }),
    [resourcesLoading, resourcesError],
  );
  const shared = [clusterId, resources, discovery, namespaces] as const;
  // One call per kind of the Workloads section, in its order: hooks may not loop.
  const kinds = [
    useKindRow(...shared, PODS),
    useKindRow(...shared, DEPLOYMENTS),
    useKindRow(...shared, DAEMONSETS),
    useKindRow(...shared, STATEFULSETS),
    useKindRow(...shared, REPLICASETS),
    useKindRow(...shared, JOBS),
    useKindRow(...shared, CRONJOBS),
  ];

  const cluster = useClusterState(clusterId);
  const options = [
    ...new Set([
      ...(cluster.status === "connected" ? cluster.info.namespaces : []),
      ...kinds.flatMap((k) => k.namespaces),
    ]),
  ];

  return (
    <section className={styles.panel} aria-label="Workloads">
      <div className={styles.toolbar}>
        <h2 className={styles.title} data-testid="workloads-overview-title">
          Workloads
        </h2>
        <NamespaceFilter
          namespaces={options}
          selected={namespaces}
          onChange={setNamespaces}
        />
      </div>
      <div className={styles.table}>
        <DataTable
          rows={kinds.map((k) => k.row)}
          columns={kindColumns(clusterId)}
          rowKey={(row) => row.kind.plural}
          rowTestId={(row) => `workload-kind-${row.kind.plural}`}
          label="Workload kinds"
          testId="workloads-kinds"
        />
      </div>
      <h3 className={styles.heading}>Recent events</h3>
      <RecentEvents
        clusterId={clusterId}
        info={findResource(resources, "", "events")}
        discovery={discovery}
        namespaces={namespaces}
      />
    </section>
  );
}
