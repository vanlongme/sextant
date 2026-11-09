import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../ipc/api";
import { failureMessage } from "../../ipc/client";
import type { LogEndReason } from "../../ipc/generated/LogEndReason";
import type { LogEvent } from "../../ipc/generated/LogEvent";
import type { LogOptions } from "../../ipc/generated/LogOptions";
import type { LogTarget } from "../../ipc/generated/LogTarget";
import {
  isPodTab,
  type LogsDockTab,
  type LogTabOptions,
} from "../../stores/dock";
import { LogBuffer } from "./logBuffer";

export type LogStatus =
  | "connecting"
  | "following"
  | "paused"
  | "previous"
  | "ended"
  | "failed";

export interface LogStream {
  /** Changes at most once per animation frame, when the buffer changed. */
  version: number;
  buffer: LogBuffer;
  status: LogStatus;
  /** The message of the last failure, verbatim. */
  error: string | null;
  /** Why the current session ended, once it has. */
  endReason: LogEndReason | null;
  /** Starts a new session with the current options. */
  retry(): void;
}

/** Which logs a tab reads (spec §5.1). */
export function logTarget(tab: LogsDockTab): LogTarget {
  const { namespace, options } = tab;
  if (isPodTab(tab)) {
    return {
      kind: "pod",
      namespace,
      pod: tab.name,
      container: options.container,
    };
  }
  if (options.pod === "all") {
    return {
      kind: "workload",
      resource: tab.resource,
      namespace,
      name: tab.name,
      container: options.container,
    };
  }
  return {
    kind: "pod",
    namespace,
    pod: options.pod,
    container: options.container,
  };
}

export function logOptions(options: LogTabOptions): LogOptions {
  return {
    follow: options.follow && !options.previous,
    previous: options.previous,
    tailLines: options.tail,
    sinceSeconds: null,
  };
}

/**
 * One start of `logs_start`, its generation. Once `stopped`, its events are dropped
 * and an id that arrives late is stopped at once.
 */
interface Session {
  id: string | null;
  stopped: boolean;
  /** Bytes stored before the id arrived, acknowledged as soon as it does. */
  unacked: number;
}

function stop(session: Session): void {
  if (session.stopped) return;
  session.stopped = true;
  // A session that already ended is gone on the backend too: nothing to report.
  if (session.id !== null) void api.logsStop(session.id).catch(() => {});
}

/**
 * The backend session of one Logs tab. It is the only caller of `logs_start`,
 * `logs_stop` and `session_ack`. The pod, container, tail and Previous start a new
 * session; Follow off stops the session and keeps the lines; Follow on starts again.
 */
export function useLogStream(tab: LogsDockTab): LogStream {
  const [buffer] = useState(() => new LogBuffer());
  const [version, setVersion] = useState(0);
  const [status, setStatus] = useState<LogStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [endReason, setEndReason] = useState<LogEndReason | null>(null);
  const [attempt, setAttempt] = useState(0);
  // The effects start on the identity in `key`; they read the latest tab from here.
  const latest = useRef(tab);
  latest.current = tab;
  const session = useRef<Session | null>(null);
  const framePending = useRef(false);
  /** The Follow value the current session was started, or stopped, for. */
  const shownFollow = useRef(tab.options.follow);

  const { follow, tail, previous } = tab.options;
  const key = JSON.stringify([tab.clusterId, logTarget(tab), tail, previous]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` and `attempt` say when to start again; the tab is read from `latest`.
  useEffect(() => {
    const current = latest.current;
    const options = logOptions(current.options);
    const settled: LogStatus = options.previous
      ? "previous"
      : options.follow
        ? "following"
        : "paused";
    const mine: Session = { id: null, stopped: false, unacked: 0 };
    session.current = mine;
    shownFollow.current = current.options.follow;
    buffer.clear();
    setVersion((v) => v + 1);
    setStatus("connecting");
    setError(null);
    setEndReason(null);

    function render(): void {
      if (framePending.current) return;
      framePending.current = true;
      requestAnimationFrame(() => {
        framePending.current = false;
        setVersion((v) => v + 1);
      });
    }

    function onEvent(event: LogEvent): void {
      if (mine.stopped) return;
      switch (event.type) {
        case "lines":
          for (const line of event.lines)
            buffer.push({ kind: "line", ...line });
          if (mine.id === null) mine.unacked += event.bytes;
          else void api.sessionAck(mine.id, event.bytes).catch(() => {});
          setStatus((s) => (s === "connecting" ? settled : s));
          render();
          break;
        case "marker":
          buffer.push({
            kind: "marker",
            pod: event.pod,
            container: event.container,
            marker: event.marker,
            message: event.message,
          });
          setStatus((s) => (s === "connecting" ? settled : s));
          render();
          break;
        case "ended":
          setEndReason(event.reason);
          setStatus(options.follow ? "ended" : settled);
          break;
        case "failed":
          setError(event.error.message);
          setStatus("failed");
          break;
      }
    }

    api.logsStart(current.clusterId, logTarget(current), options, onEvent).then(
      (id) => {
        if (mine.stopped) {
          void api.logsStop(id).catch(() => {});
          return;
        }
        mine.id = id;
        if (mine.unacked > 0) {
          void api.sessionAck(id, mine.unacked).catch(() => {});
          mine.unacked = 0;
        }
      },
      (e: unknown) => {
        if (mine.stopped) return;
        setError(failureMessage(e));
        setStatus("failed");
      },
    );
    return () => stop(mine);
  }, [key, attempt, buffer]);

  // Follow off stops the session and keeps the lines; Follow on starts a new one.
  useEffect(() => {
    if (shownFollow.current === follow) return;
    shownFollow.current = follow;
    if (follow) {
      setAttempt((a) => a + 1);
      return;
    }
    if (session.current) stop(session.current);
    setStatus((s) => (s === "failed" ? s : previous ? "previous" : "paused"));
  }, [follow, previous]);

  const retry = useCallback(() => setAttempt((a) => a + 1), []);

  return { version, buffer, status, error, endReason, retry };
}
