import { useEffect, useId, useRef } from "react";
import styles from "./RadioGroup.module.css";

export interface RadioOption<T extends string> {
  value: T;
  label: string;
  /** A line under the label, which also describes the radio. */
  description?: string;
}

/**
 * One choice from a short list, each option with a line that explains it. A fieldset
 * named by its legend holds native radio inputs, which carry the choice, the focus and
 * the arrow keys. As in `Segmented`, a native `change` listener on the group catches the
 * arrow-key choice, because WebKitGTK fires `change` without `click` and React's radio
 * onChange listens only to `click`. Each option's test id, `<testId>-<value>`, is on its
 * label, the part a pointer can click.
 */
export function RadioGroup<T extends string>(props: {
  legend: string;
  value: T;
  options: RadioOption<T>[];
  onChange(value: T): void;
  testId?: string;
}) {
  const name = useId();
  const groupRef = useRef<HTMLFieldSetElement>(null);
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
    <fieldset
      ref={groupRef}
      className={styles.group}
      data-testid={props.testId}
    >
      <legend className={styles.legend}>{props.legend}</legend>
      {props.options.map((o) => {
        const labelId = `${name}-${o.value}-label`;
        const descriptionId = `${name}-${o.value}-description`;
        const checked = o.value === props.value;
        return (
          <label
            key={o.value}
            className={styles.option}
            data-checked={checked}
            data-testid={
              props.testId ? `${props.testId}-${o.value}` : undefined
            }
          >
            <input
              type="radio"
              className={styles.input}
              name={name}
              value={o.value}
              checked={checked}
              aria-labelledby={labelId}
              aria-describedby={
                o.description === undefined ? undefined : descriptionId
              }
              onChange={() => props.onChange(o.value)}
            />
            <span className={styles.text}>
              <span id={labelId} className={styles.label}>
                {o.label}
              </span>
              {o.description === undefined ? null : (
                <span id={descriptionId} className={styles.description}>
                  {o.description}
                </span>
              )}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
