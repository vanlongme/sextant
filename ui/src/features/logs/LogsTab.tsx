import { Download } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, IconButton } from "../../design";
import { isPodTab, type LogsDockTab, useDock } from "../../stores/dock";
import { LogsSearch } from "./LogsSearch";
import styles from "./LogsTab.module.css";
import { LogsToolbar } from "./LogsToolbar";
import { type LogJump, LogView } from "./LogView";
import { useLogDownload } from "./logDownload";
import {
  hitsText,
  type LogMatch,
  SEARCH_DELAY_MS,
  SearchIndex,
} from "./logSearch";
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
  const download = useLogDownload(tab);
  const [query, setQuery] = useState("");
  const [applied, setApplied] = useState("");
  const [jump, setJump] = useState<LogJump | null>(null);
  const [search] = useState(() => new SearchIndex());
  const nonce = useRef(0);
  const { options } = tab;

  // The query runs 150 ms after the last keystroke.
  useEffect(() => {
    if (query === applied) return;
    const timer = setTimeout(() => setApplied(query), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query, applied]);

  // The matches follow the query and the lines as they arrive. Running it again
  // with nothing new changes nothing.
  search.sync(applied, stream.buffer);

  function goTo(match: LogMatch | null): void {
    if (!match) return;
    nonce.current += 1;
    setJump({ seq: match.seq, nonce: nonce.current });
  }

  // A new query goes to its first match.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the applied query changes.
  useEffect(() => {
    goTo(search.currentMatch);
  }, [applied]);

  function step(direction: 1 | -1): void {
    // Enter on a query still waiting for its delay runs it at once.
    if (query !== applied) {
      setApplied(query);
      return;
    }
    goTo(search.step(direction));
  }

  const prefix = prefixMode({
    podTab: isPodTab(tab),
    pod: options.pod,
    container: options.container,
    containerCount: sources.containers.length,
  });
  const gone = stream.endReason === "podGone";
  const hasNote = stream.error !== null || gone || download.note !== null;

  return (
    <div className={styles.root} data-testid="logs-tab">
      <LogsToolbar
        tab={tab}
        sources={sources}
        status={stream.status}
        onChange={(patch) => useDock.getState().setLogOptions(tab.id, patch)}
        trailing={
          <>
            <LogsSearch
              query={query}
              hits={hitsText(
                applied,
                stream.buffer.lines,
                search.matches.length,
                search.current,
              )}
              hasMatches={search.matches.length > 0}
              onQuery={setQuery}
              onStep={step}
            />
            <IconButton
              label="Download all lines"
              icon={<Download size={16} aria-hidden="true" />}
              disabled={download.saving}
              onClick={() => void download.download()}
              data-testid="logs-download"
            />
          </>
        }
      />
      {hasNote ? (
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
          {download.note ? (
            <span
              className={download.note.failed ? styles.danger : undefined}
              data-testid="logs-download-note"
            >
              {download.note.text}
            </span>
          ) : null}
        </div>
      ) : null}
      <LogView
        buffer={stream.buffer}
        version={stream.version}
        timestamps={options.timestamps}
        wrap={options.wrap}
        prefix={prefix}
        empty={emptyText(stream, sources)}
        search={search}
        jump={jump}
      />
    </div>
  );
}
