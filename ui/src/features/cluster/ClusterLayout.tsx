import { useEffect, useMemo, useRef } from "react";
import { Outlet, useOutletContext, useParams } from "react-router";
import { EmptyState } from "../../design";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import { groupFromSegment } from "../../kinds/nav";
import {
  findResource,
  useApiResources,
  useResourceList,
} from "../../stores/resources";
import styles from "./ClusterLayout.module.css";
import { Sidebar } from "./Sidebar";

/** What the layout hands to the routes below it. */
export interface ClusterOutletContext {
  clusterId: string;
  busy: boolean;
  onDisconnect(): void;
  resources: ApiResourceInfo[];
  resourcesLoading: boolean;
  resourcesError: string | null;
}

export function useClusterContext(): ClusterOutletContext {
  return useOutletContext<ClusterOutletContext>();
}

/**
 * Re-discovers the served resources when the set of custom resource definitions
 * changes, so new custom resources appear in the sidebar.
 */
function useRefreshOnCrdChange(
  clusterId: string,
  resources: ApiResourceInfo[],
  refresh: () => Promise<void>,
): void {
  const crd = findResource(
    resources,
    "apiextensions.k8s.io",
    "customresourcedefinitions",
  );
  const ref = useMemo(
    () => (crd?.canList && crd.canWatch ? crd.resource : null),
    [crd],
  );
  const list = useResourceList(clusterId, ref);
  const names =
    ref === null || list.loading
      ? null
      : list.items
          .map((o) => o.metadata.name)
          .sort()
          .join("\n");
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (names === null) return;
    const previous = last.current;
    last.current = names;
    if (previous !== null && previous !== names) void refresh();
  }, [names, refresh]);
}

/** The sidebar and the routed content of a connected cluster. */
export function ClusterLayout(props: {
  clusterId: string;
  busy: boolean;
  onDisconnect(): void;
}) {
  const { clusterId, busy, onDisconnect } = props;
  const { resources, loading, error, refresh } = useApiResources(clusterId);
  useRefreshOnCrdChange(clusterId, resources, refresh);
  const context: ClusterOutletContext = {
    clusterId,
    busy,
    onDisconnect,
    resources,
    resourcesLoading: loading,
    resourcesError: error,
  };
  return (
    <div className={styles.layout}>
      <Sidebar
        clusterId={clusterId}
        resources={resources}
        loading={loading}
        error={error}
        onRetry={() => void refresh()}
      />
      <div className={styles.main}>
        <Outlet context={context} />
      </div>
    </div>
  );
}

/** The route for one resource list. Task 8 replaces this with the table. */
export function ResourceRoute() {
  const { group = "", plural = "" } = useParams();
  const { resources, resourcesLoading } = useClusterContext();
  const info = findResource(resources, groupFromSegment(group), plural);
  if (!info) {
    return resourcesLoading ? null : (
      <EmptyState
        title="Resource not available"
        body="This cluster does not serve this resource."
      />
    );
  }
  return <h2 data-testid="resource-title">{info.resource.kind}</h2>;
}
