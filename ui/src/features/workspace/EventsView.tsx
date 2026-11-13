import { useMemo } from "react";
import { Badge, Spinner, useNow } from "../../design";
import {
  eventLastSeen,
  eventObjectText,
  eventStatus,
} from "../../kinds/cluster/cluster";
import { formatAge, type KubeObject } from "../../kinds/objects";
import { useResourceList } from "../../stores/resources";
import { EVENTS, recentEvents } from "./views";
import styles from "./views.module.css";

/** One event: age, then (with `badge`) Normal or Warning, `Kind/name` and message. */
function EventRow(props: { event: KubeObject; now: number; badge: boolean }) {
  const { event, now } = props;
  const status = eventStatus(event);
  return (
    <li className={styles.event} data-testid="workspace-event">
      <span className={styles.age}>{formatAge(eventLastSeen(event), now)}</span>
      {props.badge ? <Badge tone={status.tone}>{status.label}</Badge> : null}
      <span className={styles.object}>{eventObjectText(event)}</span>
      <span className={styles.message}>{event.message ?? ""}</span>
    </li>
  );
}

/**
 * Events of the last hour, newest first, at most `limit`: every event, or Warning
 * events only (spec E §15.5).
 */
export function EventList(props: {
  clusterId: string;
  limit: number;
  warnings?: boolean;
  empty: string;
  testId: string;
}) {
  const list = useResourceList(props.clusterId, EVENTS);
  const now = useNow();
  const events = useMemo(
    () =>
      recentEvents(list.items, now, {
        limit: props.limit,
        warnings: props.warnings,
      }),
    [list.items, now, props.limit, props.warnings],
  );
  if (list.loading) {
    return (
      <div className={styles.loading} data-testid={props.testId}>
        <Spinner label="Loading" />
      </div>
    );
  }
  if (events.length === 0) {
    return (
      <p className={styles.empty} data-testid={props.testId}>
        {list.message !== null ? list.message : props.empty}
      </p>
    );
  }
  return (
    <ol className={styles.events} data-testid={props.testId}>
      {events.map((event) => (
        <EventRow
          key={event.metadata.uid ?? event.metadata.name}
          event={event}
          now={now}
          badge={!props.warnings}
        />
      ))}
    </ol>
  );
}

/** Every event of the cluster from the last hour, at most 200 (spec E §15.5). */
export function EventsView(props: { clusterId: string }) {
  return (
    <div className={styles.view}>
      <EventList
        clusterId={props.clusterId}
        limit={200}
        empty="No events in the last hour."
        testId="workspace-events"
      />
    </div>
  );
}
