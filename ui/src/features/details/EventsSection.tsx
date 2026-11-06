import { useEffect, useState } from "react";
import { Badge, ErrorNotice, Spinner } from "../../design";
import { api } from "../../ipc/api";
import { failureMessage } from "../../ipc/client";
import type { InvolvedRef } from "../../ipc/generated/InvolvedRef";
import { formatAge, type KubeObject } from "../../kinds/objects";
import styles from "./DetailDrawer.module.css";

interface KubeEvent {
  type?: string;
  reason?: string;
  message?: string;
  count?: number;
  lastTimestamp?: string;
  eventTime?: string;
  series?: { lastObservedTime?: string };
  metadata?: { name?: string; creationTimestamp?: string };
}

type State =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "done"; events: KubeEvent[] };

function lastSeen(e: KubeEvent): string | undefined {
  return (
    e.series?.lastObservedTime ??
    e.lastTimestamp ??
    e.eventTime ??
    e.metadata?.creationTimestamp
  );
}

/** The events about one object. A failure is shown here and nowhere else. */
export function EventsSection(props: {
  clusterId: string;
  kind: string;
  object: KubeObject;
}) {
  const { clusterId, kind, object } = props;
  const { name, namespace, uid } = object.metadata;
  const [state, setState] = useState<State>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the load.
  useEffect(() => {
    let current = true;
    setState({ phase: "loading" });
    const involved: InvolvedRef = {
      kind,
      namespace: namespace ?? null,
      name,
      uid: uid ?? null,
    };
    api.resourceEvents(clusterId, involved).then(
      (events) => {
        if (current) {
          setState({ phase: "done", events: events as unknown as KubeEvent[] });
        }
      },
      (error) => {
        if (current)
          setState({ phase: "error", message: failureMessage(error) });
      },
    );
    return () => {
      current = false;
    };
  }, [clusterId, kind, name, namespace, uid, attempt]);

  const now = Date.now();
  return (
    <section className={styles.section} data-testid="detail-events">
      <h4 className={styles.heading}>Events</h4>
      {state.phase === "loading" ? (
        <Spinner label="Loading events" />
      ) : state.phase === "error" ? (
        <ErrorNotice
          title="Could not load events"
          message={state.message}
          onRetry={() => setAttempt(attempt + 1)}
        />
      ) : state.events.length === 0 ? (
        <p className={styles.muted}>No events for this object.</p>
      ) : (
        <ul className={styles.rows}>
          {state.events.map((e, i) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: events have no stable identity here.
              key={`${e.metadata?.name ?? ""}-${i}`}
              className={styles.condition}
            >
              <span className={styles.conditionHead}>
                <Badge tone={e.type === "Warning" ? "warn" : "neutral"}>
                  {e.type ?? "Normal"}
                </Badge>
                <strong>{e.reason ?? ""}</strong>
                {e.count && e.count > 1 ? (
                  <span className={styles.muted}>x{e.count}</span>
                ) : null}
                <span className={styles.muted}>
                  {formatAge(lastSeen(e), now)}
                </span>
              </span>
              {e.message ? (
                <span className={styles.message}>{e.message}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
