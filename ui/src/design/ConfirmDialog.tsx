import type { ReactNode } from "react";
import { Button } from "./Button";
import styles from "./ConfirmDialog.module.css";
import { Dialog } from "./Dialog";

export function ConfirmDialog(props: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm(): void;
  onCancel(): void;
}) {
  return (
    <Dialog
      open={props.open}
      onOpenChange={(o) => {
        if (!o) props.onCancel();
      }}
      title={props.title}
      footer={
        <>
          <Button variant="ghost" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button
            variant={props.danger ? "danger" : "primary"}
            onClick={props.onConfirm}
          >
            {props.confirmLabel}
          </Button>
        </>
      }
    >
      <div className={styles.body}>{props.body}</div>
    </Dialog>
  );
}
