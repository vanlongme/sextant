import type { ReactNode } from "react";
import styles from "./EmptyState.module.css";

export function EmptyState(props: {
  title: string;
  body?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={styles.empty}>
      <h3 className={styles.title}>{props.title}</h3>
      {props.body ? <div className={styles.body}>{props.body}</div> : null}
      {props.action ? (
        <div className={styles.action}>{props.action}</div>
      ) : null}
    </div>
  );
}
