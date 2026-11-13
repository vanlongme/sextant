import { Spinner } from "../../design";
import { useResourceList } from "../../stores/resources";
import { Chips, ObjectLink, Part, SimpleTable } from "../detail/parts";
import type { DetailProps } from "../registry";
import { healthStatus, syncStatus } from "./application";
import {
  belongsTo,
  projectDestinations,
  type SyncWindow,
  syncWindows,
} from "./appProject";
import styles from "./argocd.module.css";
import {
  APPLICATIONS,
  ARGO_API_VERSION,
  isText,
  list,
  type Obj,
} from "./common";

/** A project's sync windows; also shown by the sync windows step (spec G §9.3). */
export function SyncWindowTable(props: { windows: SyncWindow[] }) {
  return (
    <SimpleTable
      headers={["Kind", "Schedule", "Duration", "Applies to", "Manual sync"]}
      rows={props.windows.map((w) => [
        w.kind,
        w.timeZone ? `${w.schedule} (${w.timeZone})` : w.schedule,
        w.duration,
        w.scope,
        w.manualSync ? "Yes" : "No",
      ])}
      empty="No sync windows."
    />
  );
}

function ProjectApplications(props: {
  clusterId: string;
  resources: DetailProps["resources"];
  project: Obj;
}) {
  const { clusterId, resources, project } = props;
  const apps = useResourceList(clusterId, APPLICATIONS);
  if (apps.status === "forbidden" || apps.status === "notServed") {
    return <p className={styles.muted}>Cannot list Applications.</p>;
  }
  if (apps.loading) return <Spinner label="Loading Applications" />;
  const rows = apps.items
    .filter((a) => belongsTo(a, project))
    .map((a) => [
      <ObjectLink
        key={`${a.metadata.namespace ?? ""}/${a.metadata.name}`}
        clusterId={clusterId}
        resources={resources}
        kind="Application"
        apiVersion={ARGO_API_VERSION}
        name={a.metadata.name}
        namespace={a.metadata.namespace}
        label={a.metadata.name}
      />,
      syncStatus(a).label,
      healthStatus(a).label,
    ]);
  return (
    <SimpleTable
      headers={["Application", "Sync", "Health"]}
      rows={rows}
      empty="No Applications use this project."
    />
  );
}

/** The AppProject's part of the drawer (spec G §6.3). */
export function AppProjectDetail(props: DetailProps) {
  const { clusterId, object: o, resources } = props;
  const windows = syncWindows(o);
  const repos = list(o.spec?.sourceRepos).filter(isText);
  return (
    <>
      <Part title="Destinations" testId="appproject-destinations">
        <SimpleTable
          headers={["Server or name", "Namespace"]}
          rows={projectDestinations(o).map((d) => [d.target, d.namespace])}
          empty="No destinations."
        />
      </Part>
      <Part title="Source repositories" testId="appproject-sources">
        {repos.length > 0 ? (
          <Chips values={repos} />
        ) : (
          <p className={styles.muted}>No source repositories.</p>
        )}
      </Part>
      <Part title="Sync windows" testId="appproject-windows">
        <SyncWindowTable windows={windows} />
        {windows.length > 0 ? (
          <p className={styles.muted}>
            SkoposIDE does not evaluate sync windows. A sync or roll back on
            this project asks you to confirm first.
          </p>
        ) : null}
      </Part>
      <Part title="Applications" testId="appproject-applications">
        <ProjectApplications
          clusterId={clusterId}
          resources={resources}
          project={o}
        />
      </Part>
    </>
  );
}
