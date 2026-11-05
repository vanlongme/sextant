import * as RD from "@radix-ui/react-dialog";
import type { ReactNode } from "react";
import styles from "./Dialog.module.css";

export function Dialog(props: {
  open: boolean;
  onOpenChange(o: boolean): void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <RD.Root open={props.open} onOpenChange={props.onOpenChange}>
      <RD.Portal>
        <RD.Overlay className={styles.overlay} />
        <RD.Content className={styles.content} aria-describedby={undefined}>
          <RD.Title className={styles.title}>{props.title}</RD.Title>
          <div className={styles.body}>{props.children}</div>
          {props.footer ? (
            <div className={styles.footer}>{props.footer}</div>
          ) : null}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
