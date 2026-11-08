import { useEffect, useId, useRef } from "react";
import styles from "./Segmented.module.css";

/**
 * Mutually exclusive options in a row. Native radio inputs carry the choice. A native
 * `change` listener on the group catches the arrow-key choice, because WebKitGTK fires
 * `change` without `click` and React's radio onChange listens only to `click`. Each option's test id, `<testId>-<value>`,
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
  const groupRef = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const onNativeChange = (e: Event) => {
      const value = (e.target as HTMLInputElement).value as T;
      if (value !== latest.current.value) latest.current.onChange(value);
    };
    group.addEventListener("change", onNativeChange);
    return () => group.removeEventListener("change", onNativeChange);
  }, []);
  return (
    <div
      ref={groupRef}
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
