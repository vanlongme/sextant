import { useId } from "react";
import styles from "./Switch.module.css";

/**
 * An on/off choice. A native checkbox with the switch role carries the state and the
 * focus; the track and thumb draw it, and the label sits on the right, with the
 * description under it when there is one. The test id is on the label, the part a
 * pointer clicks.
 */
export function Switch(props: {
  label: string;
  checked: boolean;
  onChange(checked: boolean): void;
  disabled?: boolean;
  size?: "sm" | "md";
  /** A second line under the label, which also describes the switch. */
  description?: string;
  testId?: string;
}) {
  const size = props.size ?? "md";
  const descriptionId = useId();
  const described = props.description !== undefined;
  return (
    <label
      className={`${styles.switch} ${styles[size]}`}
      data-testid={props.testId}
      data-checked={props.checked}
      data-disabled={props.disabled ? true : undefined}
    >
      <input
        type="checkbox"
        role="switch"
        className={styles.input}
        checked={props.checked}
        aria-checked={props.checked}
        aria-label={described ? props.label : undefined}
        aria-describedby={described ? descriptionId : undefined}
        disabled={props.disabled}
        onChange={(e) => {
          if (!props.disabled) props.onChange(e.target.checked);
        }}
      />
      <span className={styles.track} aria-hidden="true">
        <span className={styles.thumb} />
      </span>
      {described ? (
        <span className={styles.text}>
          <span>{props.label}</span>
          <span id={descriptionId} className={styles.description}>
            {props.description}
          </span>
        </span>
      ) : (
        <span>{props.label}</span>
      )}
    </label>
  );
}
