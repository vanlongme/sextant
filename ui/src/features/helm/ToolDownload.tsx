import { Download } from "lucide-react";
import { Button, ProgressBar } from "../../design";
import type { ToolStatus } from "../../ipc/generated/ToolStatus";
import { useHelm } from "../../stores/helm";
import styles from "./Helm.module.css";
import { toolView } from "./toolView";

/**
 * The download part of a tool row: the bar, its text and Cancel while a download
 * runs, else the Download button when the tool is missing and has a managed version.
 */
export function ToolDownload(props: {
  status: ToolStatus;
  ids: { progress: string; cancel: string; download: string };
  /** Shows the progress text next to the bar, where no row text says it. */
  showText?: boolean;
}) {
  const { status, ids } = props;
  const progress = useHelm((s) => s.tools.progress[status.tool]);
  const downloadTool = useHelm((s) => s.downloadTool);
  const cancelDownload = useHelm((s) => s.cancelDownload);
  const view = toolView(status, progress);
  if (view.inFlight) {
    return (
      <div className={styles.download}>
        <span className={styles.downloadBar}>
          <ProgressBar
            label={view.text}
            value={view.percent}
            testId={ids.progress}
          />
        </span>
        {props.showText ? (
          <span className={styles.downloadText}>{view.text}</span>
        ) : null}
        <Button
          size="sm"
          onClick={() => {
            void cancelDownload(status.tool);
          }}
          data-testid={ids.cancel}
        >
          Cancel
        </Button>
      </div>
    );
  }
  if (view.download === null) return null;
  return (
    <Button
      size="sm"
      variant="primary"
      onClick={() => {
        void downloadTool(status.tool);
      }}
      data-testid={ids.download}
    >
      <Download size={14} aria-hidden="true" />
      {view.download}
    </Button>
  );
}
