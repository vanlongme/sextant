import styles from "./ProgressBar.module.css";

/**
 * How far something has got. `value` runs from 0 to 100; null means unknown, which
 * leaves out `aria-valuenow` and moves a short bar along the track.
 */
export function ProgressBar(props: {
  label: string;
  value: number | null;
  testId?: string;
}) {
  const value =
    props.value === null
      ? null
      : Math.round(Math.min(100, Math.max(0, props.value)));
  return (
    <div
      role="progressbar"
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value ?? undefined}
      data-indeterminate={value === null ? true : undefined}
      data-testid={props.testId}
      className={styles.track}
    >
      <span
        className={
          value === null ? `${styles.fill} ${styles.moving}` : styles.fill
        }
        style={value === null ? undefined : { width: `${value}%` }}
      />
    </div>
  );
}
