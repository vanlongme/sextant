import * as RT from "@radix-ui/react-tabs";
import styles from "./Tabs.module.css";

export function Tabs(props: {
  value: string;
  onChange(v: string): void;
  /** A tab with a `testId` carries it on its trigger. */
  tabs: { value: string; label: string; testId?: string }[];
}) {
  return (
    <RT.Root value={props.value} onValueChange={props.onChange}>
      <RT.List className={styles.list}>
        {props.tabs.map((t) => (
          <RT.Trigger
            key={t.value}
            value={t.value}
            className={styles.tab}
            data-testid={t.testId}
          >
            {t.label}
          </RT.Trigger>
        ))}
      </RT.List>
    </RT.Root>
  );
}
