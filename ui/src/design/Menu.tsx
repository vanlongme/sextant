import * as RM from "@radix-ui/react-dropdown-menu";
import type { ReactNode } from "react";
import styles from "./Menu.module.css";

export function Menu(props: {
  trigger: ReactNode;
  items: {
    id: string;
    label: string;
    icon?: ReactNode;
    danger?: boolean;
    disabled?: boolean;
    onSelect(): void;
  }[];
}) {
  return (
    <RM.Root>
      <RM.Trigger asChild>{props.trigger}</RM.Trigger>
      <RM.Portal>
        <RM.Content className={styles.content} align="end" sideOffset={4}>
          {props.items.map((it) => (
            <RM.Item
              key={it.id}
              className={`${styles.item} ${it.danger ? styles.danger : ""}`}
              disabled={it.disabled}
              onSelect={it.onSelect}
              data-testid={`menu-item-${it.id}`}
            >
              {it.icon ? <span className={styles.icon}>{it.icon}</span> : null}
              {it.label}
            </RM.Item>
          ))}
        </RM.Content>
      </RM.Portal>
    </RM.Root>
  );
}
