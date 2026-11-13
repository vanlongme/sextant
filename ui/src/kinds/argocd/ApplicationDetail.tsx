import { useNow } from "../../design/VirtualTable";
import { Facts, ObjectLink, Part, SimpleTable } from "../detail/parts";
import { formatAge } from "../objects";
import type { DetailProps } from "../registry";
import {
  appHistory,
  appResources,
  appSources,
  autoSyncText,
  deletesResources,
  destinationText,
  isDeleting,
  lastOperation,
  operationNote,
  projectLocation,
  refreshRequested,
} from "./application";
import styles from "./argocd.module.css";
import { ARGO_API_VERSION, NONE } from "./common";

function ago(iso: string | undefined, now: number): string {
  return iso ? `${formatAge(iso, now)} ago` : NONE;
}

/** The Application's part of the drawer (spec G §6.1). */
export function ApplicationDetail(props: DetailProps) {
  const { clusterId, object: o, resources } = props;
  const now = useNow();
  const note = operationNote(o, now);
  const project = projectLocation(o);
  const sources = appSources(o);
  const last = lastOperation(o);
  const refresh = refreshRequested(o);
  return (
    <>
      {note ? (
        <p
          className={styles.note}
          role="status"
          data-testid="argocd-operation-note"
        >
          {note}
        </p>
      ) : null}
      <Facts
        items={[
          [
            "Project",
            <ObjectLink
              key="project"
              clusterId={clusterId}
              resources={resources}
              kind="AppProject"
              apiVersion={ARGO_API_VERSION}
              name={project.name}
              namespace={project.namespace}
              label={project.name}
            />,
          ],
          ["Auto-sync", autoSyncText(o)],
          ["Destination", destinationText(o)],
          ["Refresh", refresh ? `Requested (${refresh})` : null],
          [
            "Deleting",
            isDeleting(o)
              ? `Since ${formatAge(o.metadata.deletionTimestamp, now)}${
                  deletesResources(o) ? ", deleting its resources too" : ""
                }`
              : null,
          ],
        ]}
      />
      <Part
        title={sources.length > 1 ? `Sources (${sources.length})` : "Source"}
        testId="argocd-sources"
      >
        <SimpleTable
          headers={["Repository", "Path or chart", "Revision"]}
          rows={sources.map((s) => [
            s.repoURL,
            s.pathOrChart,
            s.ref ? `${s.targetRevision} · ref ${s.ref}` : s.targetRevision,
          ])}
          empty="No source."
        />
      </Part>
      <Part title="Last operation" testId="argocd-last-operation">
        {last ? (
          <Facts
            items={[
              ["Phase", last.phase],
              ["Message", last.message],
              ["Started", ago(last.startedAt, now)],
              ["Finished", ago(last.finishedAt, now)],
              ["Initiated by", last.initiatedBy],
            ]}
          />
        ) : (
          <p className={styles.muted}>No operation yet.</p>
        )}
      </Part>
      <Part title="Resources" testId="argocd-resources">
        <SimpleTable
          headers={["Kind", "Name", "Sync", "Health"]}
          rows={appResources(o).map((r) => [
            r.kind,
            <ObjectLink
              key={`${r.kind}/${r.namespace ?? ""}/${r.name}`}
              clusterId={clusterId}
              resources={resources}
              kind={r.kind}
              apiVersion={r.apiVersion}
              name={r.name}
              namespace={r.namespace}
              label={r.name}
            />,
            r.sync,
            r.health,
          ])}
          empty="Argo CD has not reported any resources."
        />
      </Part>
      <Part title="History" testId="argocd-history">
        <SimpleTable
          headers={["ID", "Revision", "Deployed", "Initiated by"]}
          rows={appHistory(o).map((h) => [
            String(h.id),
            h.revision,
            ago(h.deployedAt, now),
            h.initiatedBy,
          ])}
          empty="Nothing has been deployed yet."
        />
      </Part>
    </>
  );
}
