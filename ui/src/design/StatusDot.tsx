import type { Tone } from "./Badge";
import styles from "./StatusDot.module.css";

export function StatusDot({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`${styles.dot} ${styles[tone]}`}
    />
  );
}
