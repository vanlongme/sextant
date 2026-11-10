import { useEffect } from "react";
import { ErrorNotice, Spinner, StatusDot } from "../../design";
import type { ToolName } from "../../ipc/generated/ToolName";
import type { ToolStatus } from "../../ipc/generated/ToolStatus";
import { useHelm } from "../../stores/helm";
import { ToolDownload } from "../helm/ToolDownload";
import { toolView } from "../helm/toolView";
import styles from "./PreferencesScreen.module.css";

const TOOLS: ToolName[] = ["helm", "kubectl"];
const DOT_LABELS = {
  ok: "Ready",
  warn: "Downloading",
  danger: "Not available",
};

function ToolRow({ status }: { status: ToolStatus }) {
  const progress = useHelm((s) => s.tools.progress[status.tool]);
  const view = toolView(status, progress);
  return (
    <li className={styles.row} data-testid={`pref-tool-${status.tool}`}>
      <StatusDot tone={view.tone} label={DOT_LABELS[view.tone]} />
      <span className={styles.toolText}>{view.text}</span>
      <span className={styles.toolAction}>
        <ToolDownload
          status={status}
          ids={{
            progress: `pref-tool-progress-${status.tool}`,
            cancel: `pref-tool-cancel-${status.tool}`,
            download: `pref-tool-download-${status.tool}`,
          }}
        />
      </span>
    </li>
  );
}

/** Preferences › Tools (spec §12.1): helm, then kubectl. */
export function ToolsSection() {
  const status = useHelm((s) => s.tools.status);
  const error = useHelm((s) => s.tools.error);
  const ensureTools = useHelm((s) => s.ensureTools);
  const loadTools = useHelm((s) => s.loadTools);

  useEffect(() => {
    void ensureTools();
  }, [ensureTools]);

  let body = null;
  if (status === null && error) {
    body = (
      <ErrorNotice
        title="Could not read the tool status"
        message={error.message}
        details={error.details}
        onRetry={() => {
          void loadTools();
        }}
      />
    );
  } else if (status === null) {
    body = <Spinner />;
  } else {
    body = (
      <ul className={styles.rows}>
        {TOOLS.map((tool) => {
          const found = status.find((s) => s.tool === tool);
          return found ? <ToolRow key={tool} status={found} /> : null;
        })}
      </ul>
    );
  }
  return (
    <section className={styles.section} data-testid="pref-tools">
      <h3 className={styles.heading}>Tools</h3>
      {body}
    </section>
  );
}
