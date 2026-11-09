import * as RS from "@radix-ui/react-select";
import { ChevronDown } from "lucide-react";
import { useId } from "react";
import styles from "./Select.module.css";

export function Select<T extends string>(props: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange(v: T): void;
  /** Keeps the label for assistive technology only, as in a toolbar. */
  hideLabel?: boolean;
  /** The trigger's width in px. */
  width?: number;
  /** Set on the trigger, the part a pointer clicks. */
  testId?: string;
}) {
  const labelId = useId();
  return (
    <div className={styles.field}>
      <span
        id={labelId}
        className={props.hideLabel ? styles.hidden : styles.label}
      >
        {props.label}
      </span>
      <RS.Root
        value={props.value}
        onValueChange={(v) => props.onChange(v as T)}
      >
        <RS.Trigger
          className={styles.trigger}
          aria-labelledby={labelId}
          style={props.width === undefined ? undefined : { width: props.width }}
          data-testid={props.testId}
        >
          <RS.Value />
          <RS.Icon aria-hidden="true" className={styles.icon}>
            <ChevronDown size={16} />
          </RS.Icon>
        </RS.Trigger>
        <RS.Portal>
          <RS.Content
            className={styles.content}
            position="popper"
            sideOffset={4}
          >
            <RS.Viewport>
              {props.options.map((o) => (
                <RS.Item key={o.value} value={o.value} className={styles.item}>
                  <RS.ItemText>{o.label}</RS.ItemText>
                </RS.Item>
              ))}
            </RS.Viewport>
          </RS.Content>
        </RS.Portal>
      </RS.Root>
    </div>
  );
}
