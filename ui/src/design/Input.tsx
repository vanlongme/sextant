import { type InputHTMLAttributes, useId } from "react";
import styles from "./Input.module.css";

export type InputProps = {
  label?: string;
  error?: string;
  /** A hint under the field, shown while there is no error. */
  help?: string;
} & InputHTMLAttributes<HTMLInputElement>;

export function Input({
  label,
  error,
  help,
  id,
  className,
  ...rest
}: InputProps) {
  const auto = useId();
  const inputId = id ?? auto;
  const errorId = `${inputId}-error`;
  const helpId = `${inputId}-help`;
  const showHelp = !error && help !== undefined;
  return (
    <div className={styles.field}>
      {label ? (
        <label htmlFor={inputId} className={styles.label}>
          {label}
        </label>
      ) : null}
      <input
        {...rest}
        id={inputId}
        className={[styles.input, error ? styles.invalid : "", className]
          .filter(Boolean)
          .join(" ")}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : showHelp ? helpId : undefined}
      />
      {error ? (
        <span id={errorId} role="alert" className={styles.error}>
          {error}
        </span>
      ) : null}
      {showHelp ? (
        <span id={helpId} className={styles.help}>
          {help}
        </span>
      ) : null}
    </div>
  );
}
