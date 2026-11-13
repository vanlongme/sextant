import { useEffect, useMemo, useRef } from "react";
import { Outlet, useOutletContext } from "react-router";
import { PaneHandle } from "../../design";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { KubeObject } from "../../kinds/objects";
import { NAV_PANE, usePaneSize } from "../../stores/paneSize";
import {
  findResource,
  useApiResources,
  useResourceList,
} from "../../stores/resources";
import { Dock } from "../dock/Dock";
import styles from "./ClusterLayout.module.css";
import { Sidebar } from "./Sidebar";

/** What the layout hands to the routes below it. */
export interface ClusterOutletContext {
  clusterId: string;
  resources: ApiResourceInfo[];
  resourcesLoading: boolean;
  resourcesError: string | null;
}

export function useClusterContext(): ClusterOutletContext {
  return useOutletContext<ClusterOutletContext>();
}

/** How long to wait before each new look at a discovery that lags the definitions. */
const REDISCOVER_DELAYS_MS = [500, 1000, 2000, 4000, 8000];

/** The `group/plural` a custom resource definition serves. */
function definedResource(crd: KubeObject): string {
  return `${crd.spec?.group}/${crd.spec?.names?.plural}`;
}

function isEstablished(crd: KubeObject): boolean {
  const conditions: { type?: string; status?: string }[] =
    crd.status?.conditions ?? [];
  return conditions.some(
    (c) => c.type === "Established" && c.status === "True",
  );
}

/**
 * Re-discovers the served resources when the set of custom resource definitions
 * changes, so new custom resources appear in the sidebar. The API server serves a
 * new definition, and stops serving a deleted one, some time after the watch says
 * so. So discovery is asked again, a limited number of times, until it agrees.
 */
function useRefreshOnCrdChange(
  clusterId: string,
  resources: ApiResourceInfo[],
  error: string | null,
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

  const seen = useRef(new Set<string>());
  const crds = ref === null || list.loading ? null : list.items;
  let behind = "";
  if (crds !== null) {
    const served = new Set(
      resources.map((r) => `${r.resource.group}/${r.resource.plural}`),
    );
    const defined = new Set(crds.map(definedResource));
    for (const resource of defined) seen.current.add(resource);
    const missing = crds
      .filter(isEstablished)
      .map(definedResource)
      .filter((resource) => !served.has(resource));
    const stale = [...seen.current].filter(
      (resource) => !defined.has(resource) && served.has(resource),
    );
    behind = [...missing, ...stale].sort().join("\n");
  }

  const attempts = useRef({ behind: "", count: 0 });
  // biome-ignore lint/correctness/useExhaustiveDependencies: each answer, in `resources`, arms the next look.
  useEffect(() => {
    if (attempts.current.behind !== behind) {
      attempts.current = { behind, count: 0 };
    }
    const delay = REDISCOVER_DELAYS_MS[attempts.current.count];
    if (behind === "" || delay === undefined) return;
    const timer = setTimeout(() => {
      attempts.current.count += 1;
      void refresh();
    }, delay);
    return () => clearTimeout(timer);
  }, [behind, resources, error, refresh]);
}

/** The sidebar and the routed content of a connected cluster. */
export function ClusterLayout(props: { clusterId: string }) {
  const { clusterId } = props;
  const { resources, loading, error, refresh } = useApiResources(clusterId);
  useRefreshOnCrdChange(clusterId, resources, error, refresh);
  const context: ClusterOutletContext = {
    clusterId,
    resources,
    resourcesLoading: loading,
    resourcesError: error,
  };
  const [navWidth, setNavWidth] = usePaneSize(NAV_PANE);
  return (
    <div
      className={styles.layout}
      style={{ gridTemplateColumns: `${navWidth}px minmax(0, 1fr)` }}
    >
      <div className={styles.nav}>
        <Sidebar
          clusterId={clusterId}
          resources={resources}
          loading={loading}
          error={error}
          onRetry={() => void refresh()}
        />
        <PaneHandle
          label="Resize navigation"
          edge="right"
          value={navWidth}
          min={NAV_PANE.min}
          max={NAV_PANE.max}
          initial={NAV_PANE.initial}
          onChange={setNavWidth}
          testId="nav-resize"
        />
      </div>
      <div className={styles.main}>
        <div className={styles.content}>
          <Outlet context={context} />
        </div>
        <Dock clusterId={clusterId} />
      </div>
    </div>
  );
}

/** Placeholder for the Workloads overview screen (F17). */
export function WorkloadsOverview() {
  return <h2 data-testid="workloads-overview-title">Workloads</h2>;
}
