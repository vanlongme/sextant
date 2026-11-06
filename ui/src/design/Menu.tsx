import * as RM from "@radix-ui/react-dropdown-menu";
import { Check } from "lucide-react";
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

/** A menu of checkboxes, which stays open so several can be changed in one go. */
export function CheckMenu(props: {
  trigger: ReactNode;
  items: {
    id: string;
    label: string;
    checked: boolean;
    testId?: string;
    onToggle(): void;
  }[];
}) {
  return (
    <RM.Root>
      <RM.Trigger asChild>{props.trigger}</RM.Trigger>
      <RM.Portal>
        <RM.Content
          className={`${styles.content} ${styles.scrolling}`}
          align="start"
          sideOffset={4}
        >
          {props.items.map((it) => (
            <RM.CheckboxItem
              key={it.id}
              className={styles.item}
              checked={it.checked}
              onCheckedChange={it.onToggle}
              onSelect={(e) => e.preventDefault()}
              data-testid={it.testId}
            >
              <span className={styles.check}>
                <RM.ItemIndicator>
                  <Check size={14} aria-hidden="true" />
                </RM.ItemIndicator>
              </span>
              {it.label}
            </RM.CheckboxItem>
          ))}
        </RM.Content>
      </RM.Portal>
    </RM.Root>
  );
}
