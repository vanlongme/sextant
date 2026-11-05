import * as RT from "@radix-ui/react-tabs";
import styles from "./Tabs.module.css";

export function Tabs(props: {
  value: string;
  onChange(v: string): void;
  tabs: { value: string; label: string }[];
}) {
  return (
    <RT.Root value={props.value} onValueChange={props.onChange}>
      <RT.List className={styles.list}>
        {props.tabs.map((t) => (
          <RT.Trigger key={t.value} value={t.value} className={styles.tab}>
            {t.label}
          </RT.Trigger>
        ))}
      </RT.List>
    </RT.Root>
  );
}
