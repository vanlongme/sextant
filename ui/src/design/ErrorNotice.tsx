import { Button } from "./Button";
import styles from "./ErrorNotice.module.css";

export function ErrorNotice(props: {
  title: string;
  message: string;
  details?: string;
  onRetry?(): void;
}) {
  return (
    <div className={styles.notice} role="alert">
      <strong className={styles.title}>{props.title}</strong>
      <p className={styles.message}>{props.message}</p>
      {props.details ? (
        <details className={styles.details}>
          <summary>Details</summary>
          <pre>{props.details}</pre>
        </details>
      ) : null}
      {props.onRetry ? (
        <Button size="sm" onClick={props.onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}
