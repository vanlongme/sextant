import { Badge } from "../../design";
import styles from "./DetailDrawer.module.css";

interface Condition {
  type: string;
  status?: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

function conditionsOf(status: unknown): Condition[] {
  const list = (status as { conditions?: unknown } | undefined)?.conditions;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (c): c is Condition =>
      typeof c === "object" && c !== null && typeof c.type === "string",
  );
}

/** The `status.conditions` of an object. Nothing is shown when it has none. */
export function ConditionsSection(props: { status: unknown }) {
  const conditions = conditionsOf(props.status);
  if (conditions.length === 0) return null;
  return (
    <section className={styles.section} data-testid="detail-conditions">
      <h4 className={styles.heading}>Conditions</h4>
      <ul className={styles.rows}>
        {conditions.map((c) => (
          <li key={c.type} className={styles.condition}>
            <span className={styles.conditionHead}>
              <strong>{c.type}</strong>
              {c.status ? (
                <Badge
                  tone={
                    c.status === "True"
                      ? "ok"
                      : c.status === "False"
                        ? "warn"
                        : "neutral"
                  }
                >
                  {c.status}
                </Badge>
              ) : null}
              {c.reason ? (
                <span className={styles.muted}>{c.reason}</span>
              ) : null}
            </span>
            {c.message ? (
              <span className={styles.message}>{c.message}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
