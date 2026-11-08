import { useId } from "react";
import styles from "./Segmented.module.css";

/**
 * Mutually exclusive options in a row. Native radio inputs carry the choice, so the
 * arrow keys move it with no extra code. Each option's test id, `<testId>-<value>`,
 * is on its label, the part a pointer can click.
 */
export function Segmented<T extends string>(props: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  size?: "sm" | "md";
  onChange(v: T): void;
  testId?: string;
}) {
  const name = useId();
  const size = props.size ?? "md";
  return (
    <div
      role="radiogroup"
      aria-label={props.label}
      className={`${styles.track} ${styles[size]}`}
      data-testid={props.testId}
    >
      {props.options.map((o) => (
        <label
          key={o.value}
          className={styles.option}
          data-testid={props.testId ? `${props.testId}-${o.value}` : undefined}
        >
          <input
            type="radio"
            className={styles.input}
            name={name}
            value={o.value}
            checked={o.value === props.value}
            onChange={() => props.onChange(o.value)}
          />
          <span className={styles.segment}>{o.label}</span>
        </label>
      ))}
    </div>
  );
}
