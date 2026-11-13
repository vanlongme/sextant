import { stringify } from "yaml";
import { ObjectLink, Part, SimpleTable } from "../detail/parts";
import type { DetailProps } from "../registry";
import { generatedApps, generatorRows } from "./applicationSet";
import styles from "./argocd.module.css";
import { ARGO_API_VERSION } from "./common";

/** The ApplicationSet's part of the drawer, read only (spec G §6.2). */
export function ApplicationSetDetail(props: DetailProps) {
  const { clusterId, object: o, resources } = props;
  const template = o.spec?.template;
  return (
    <>
      <Part title="Generators" testId="appset-generators">
        <SimpleTable
          headers={["Type", "Summary"]}
          rows={generatorRows(o).map((g) => [g.type, g.summary])}
          empty="No generators."
        />
      </Part>
      <Part title="Applications it generates" testId="appset-applications">
        <SimpleTable
          headers={["Application", "Sync", "Health"]}
          rows={generatedApps(o).map((a) => [
            <ObjectLink
              key={a.name}
              clusterId={clusterId}
              resources={resources}
              kind="Application"
              apiVersion={ARGO_API_VERSION}
              name={a.name}
              namespace={a.namespace ?? o.metadata.namespace}
              label={a.name}
            />,
            a.sync,
            a.health,
          ])}
          empty="No Applications reported."
        />
      </Part>
      <Part title="Template" testId="appset-template">
        {template === undefined || template === null ? (
          <p className={styles.muted}>No template.</p>
        ) : (
          <pre className={styles.yaml}>{stringify(template)}</pre>
        )}
      </Part>
      <Part title="Changes">
        <p className={styles.muted}>
          SkoposIDE shows ApplicationSets read only. Change them in git, or with
          Edit.
        </p>
      </Part>
    </>
  );
}
