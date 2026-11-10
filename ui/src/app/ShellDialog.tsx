import * as RD from "@radix-ui/react-dialog";
import type { ReactNode } from "react";
import dialogStyles from "../design/Dialog.module.css";
import styles from "./ShellDialog.module.css";

/**
 * Where the focus goes when the last shell dialog closes. One shell dialog can
 * replace another (the palette runs About), so the first one's opener is kept.
 */
let returnTo: HTMLElement | null = null;

function rememberFocus(): void {
  const active = document.activeElement;
  if (
    active instanceof HTMLElement &&
    active !== document.body &&
    active.closest("[data-shell-dialog]") === null
  ) {
    returnTo = active;
  }
}

/** Keeps the opener, then focuses the control marked `data-autofocus`, if any;
 * otherwise Radix focuses the first control. */
function openAutoFocus(event: Event): void {
  rememberFocus();
  const preferred =
    event.target instanceof Element
      ? event.target.querySelector<HTMLElement>("[data-autofocus]")
      : null;
  if (preferred !== null) {
    event.preventDefault();
    preferred.focus();
  }
}

function restoreFocus(event: Event): void {
  // Radix would focus the dialog's trigger, and these dialogs have none.
  event.preventDefault();
  if (document.querySelector("[data-shell-dialog]") !== null) return;
  const target = returnTo;
  returnTo = null;
  if (target?.isConnected) target.focus();
}

/**
 * The palette, Keyboard shortcuts and About (spec C §4.3). `data-shell-dialog` lets
 * the shell keys tell them from other modal dialogs. The palette sits on a plain
 * scrim; the panels on the design system's blurred one.
 */
export function ShellDialog(props: {
  open: boolean;
  onClose(): void;
  label: string;
  testId: string;
  kind: "palette" | "panel";
  children: ReactNode;
}) {
  const palette = props.kind === "palette";
  return (
    <RD.Root
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <RD.Portal>
        <RD.Overlay className={palette ? styles.scrim : dialogStyles.overlay} />
        <RD.Content
          className={palette ? styles.palette : styles.panel}
          aria-label={props.label}
          aria-describedby={undefined}
          data-shell-dialog=""
          data-testid={props.testId}
          onOpenAutoFocus={openAutoFocus}
          onCloseAutoFocus={restoreFocus}
        >
          <RD.Title asChild>
            <span className={styles.hidden}>{props.label}</span>
          </RD.Title>
          {props.children}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
