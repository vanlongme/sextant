import styles from "./Spinner.module.css";

export function Spinner({ label }: { label?: string }) {
  return (
    <span className={styles.wrap} role="status" aria-label={label ?? "Loading"}>
      <span className={styles.spinner} aria-hidden="true" />
      {label ? <span className={styles.label}>{label}</span> : null}
    </span>
  );
}
