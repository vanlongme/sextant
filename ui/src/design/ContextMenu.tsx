import * as RC from "@radix-ui/react-context-menu";
import type { ReactElement } from "react";
import styles from "./Menu.module.css";

export function ContextMenu(props: {
  children: ReactElement;
  items: { id: string; label: string; onSelect(): void }[];
}) {
  return (
    <RC.Root>
      <RC.Trigger asChild>{props.children}</RC.Trigger>
      <RC.Portal>
        <RC.Content className={styles.content}>
          {props.items.map((it) => (
            <RC.Item
              key={it.id}
              className={styles.item}
              onSelect={it.onSelect}
              data-testid={`menu-item-${it.id}`}
            >
              {it.label}
            </RC.Item>
          ))}
        </RC.Content>
      </RC.Portal>
    </RC.Root>
  );
}
