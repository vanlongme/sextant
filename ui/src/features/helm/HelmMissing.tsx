import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { Button } from "../../design";
import type { ToolStatus } from "../../ipc/generated/ToolStatus";
import { useHelm } from "../../stores/helm";
import styles from "./Helm.module.css";
import { ToolDownload } from "./ToolDownload";

function usable(status: ToolStatus): boolean {
  return (
    status.source !== "missing" &&
    !(status.source === "preferences" && status.problem)
  );
}

/**
 * What a Helm screen shows when a call rejects with ToolMissing (spec §5.5). It calls
 * `onReady` when helm becomes usable while it is shown, so the screen loads again.
 */
export function HelmMissing(props: { message: string; onReady(): void }) {
  const navigate = useNavigate();
  const ensureTools = useHelm((s) => s.ensureTools);
  const helm = useHelm((s) => s.tools.status?.find((t) => t.tool === "helm"));
  const ready = helm ? usable(helm) : null;
  const was = useRef(ready);
  const onReady = useRef(props.onReady);
  onReady.current = props.onReady;

  useEffect(() => {
    void ensureTools();
  }, [ensureTools]);

  useEffect(() => {
    if (was.current === false && ready === true) onReady.current();
    was.current = ready;
  }, [ready]);

  const problem =
    helm?.source === "preferences" && helm.problem ? helm.problem : null;
  return (
    <div className={styles.missing} data-testid="helm-missing">
      <h3 className={styles.missingTitle}>helm is not available</h3>
      <p className={styles.missingText}>{props.message}</p>
      {problem !== null ? (
        <>
          <p className={styles.missingText}>{problem}</p>
          <Button
            size="sm"
            onClick={() => {
              void navigate("/preferences");
            }}
            data-testid="helm-open-prefs"
          >
            Open Preferences
          </Button>
        </>
      ) : null}
      {helm && helm.source === "missing" ? (
        <ToolDownload
          status={helm}
          showText
          ids={{
            progress: "helm-download-progress",
            cancel: "helm-download-cancel",
            download: "helm-download",
          }}
        />
      ) : null}
    </div>
  );
}
