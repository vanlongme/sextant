import { Button } from "../../design";
import { isPodTab, type LogsDockTab, useDock } from "../../stores/dock";
import styles from "./LogsTab.module.css";
import { LogsToolbar } from "./LogsToolbar";
import { LogView } from "./LogView";
import { type LogSources, useLogSources } from "./logSources";
import { prefixMode } from "./paint";
import { type LogStream, useLogStream } from "./useLogStream";

export function pendingText(message: string | null): string {
  return message
    ? `No logs yet. The Pod is Pending. ${message}`
    : "No logs yet. The Pod is Pending.";
}

/** What the list says while it has no line (spec §6.9). A failure says it in the note row. */
function emptyText(stream: LogStream, sources: LogSources): string | null {
  if (stream.buffer.lines > 0 || stream.status === "failed") return null;
  if (sources.pending) return pendingText(sources.pending.message);
  if (stream.status === "connecting") return "Connecting…";
  return "No log lines for this selection.";
}

/** A Logs dock tab: the toolbar, the note row and the lines. */
export function LogsTab({ tab }: { tab: LogsDockTab }) {
  const stream = useLogStream(tab);
  const sources = useLogSources(tab);
  const { options } = tab;
  const prefix = prefixMode({
    podTab: isPodTab(tab),
    pod: options.pod,
    container: options.container,
    containerCount: sources.containers.length,
  });
  const gone = stream.endReason === "podGone";

  return (
    <div className={styles.root} data-testid="logs-tab">
      <LogsToolbar
        tab={tab}
        sources={sources}
        status={stream.status}
        onChange={(patch) => useDock.getState().setLogOptions(tab.id, patch)}
      />
      {stream.error !== null || gone ? (
        <div className={styles.note} data-testid="logs-note">
          {stream.error !== null ? (
            <>
              <span className={styles.danger}>
                {`Could not read the logs: ${stream.error}`}
              </span>
              <Button
                variant="secondary"
                size="sm"
                onClick={stream.retry}
                data-testid="logs-retry"
              >
                Retry
              </Button>
            </>
          ) : null}
          {gone ? <span>The Pod is gone.</span> : null}
        </div>
      ) : null}
      <LogView
        buffer={stream.buffer}
        version={stream.version}
        timestamps={options.timestamps}
        wrap={options.wrap}
        prefix={prefix}
        empty={emptyText(stream, sources)}
      />
    </div>
  );
}
