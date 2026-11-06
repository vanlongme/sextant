import { Link } from "react-router";
import {
  Badge,
  type Column,
  DataTable,
  ErrorNotice,
  Spinner,
} from "../../design";
import { useResourceList } from "../../stores/resources";
import type { KubeObject } from "../objects";
import { PODS } from "../refs";
import { podStatus, podSummary } from "./pod";
import styles from "./workloads.module.css";

function podHref(clusterId: string, pod: KubeObject): string {
  const key = `${pod.metadata.namespace ?? ""}/${pod.metadata.name}`;
  return `/cluster/${encodeURIComponent(clusterId)}/r/core/pods?object=${encodeURIComponent(key)}`;
}

/** The pods of a cluster that `match` accepts, optionally within one namespace. */
export function PodList(props: {
  clusterId: string;
  match(pod: KubeObject): boolean;
  namespace?: string;
}) {
  const { clusterId, match, namespace } = props;
  const list = useResourceList(clusterId, PODS);

  if (list.status === "forbidden" || list.status === "notServed") {
    return (
      <ErrorNotice
        title="Pods cannot be listed"
        message={list.message ?? "Pods are not available."}
      />
    );
  }
  if (list.loading) {
    return (
      <div data-testid="detail-pods-loading">
        <Spinner label="Loading pods" />
      </div>
    );
  }

  const rows = list.items.filter(
    (pod) =>
      (namespace === undefined || pod.metadata.namespace === namespace) &&
      match(pod),
  );
  const columns: Column<KubeObject>[] = [
    {
      id: "name",
      header: "Name",
      sortValue: (p) => p.metadata.name,
      render: (p) => (
        <Link className={styles.link} to={podHref(clusterId, p)}>
          {p.metadata.name}
        </Link>
      ),
    },
    {
      id: "status",
      header: "Status",
      sortValue: (p) => podSummary(p).status,
      render: (p) => {
        const { label, tone } = podStatus(p);
        return <Badge tone={tone}>{label}</Badge>;
      },
    },
    {
      id: "ready",
      header: "Ready",
      render: (p) => podSummary(p).ready,
    },
    {
      id: "restarts",
      header: "Restarts",
      sortValue: (p) => podSummary(p).restarts,
      render: (p) => String(podSummary(p).restarts),
    },
    {
      id: "node",
      header: "Node",
      sortValue: (p) => p.spec?.nodeName ?? "",
      render: (p) => p.spec?.nodeName ?? "-",
    },
  ];
  return (
    <DataTable
      testId="detail-pods"
      rows={rows}
      columns={columns}
      rowKey={(p) => `${p.metadata.namespace ?? ""}/${p.metadata.name}`}
      empty={<p className={styles.muted}>No pods.</p>}
    />
  );
}
