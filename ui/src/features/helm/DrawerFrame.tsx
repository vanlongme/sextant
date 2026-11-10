import { X } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { IconButton } from "../../design";
import styles from "../details/DetailDrawer.module.css";

/**
 * The resource drawer's frame: focus comes in on open and goes back on close, and
 * Escape inside the drawer closes it.
 */
export function DrawerFrame(props: {
  label: string;
  testId: string;
  title: string;
  kind: string;
  /** After the kind line, such as a status badge. */
  extra?: ReactNode;
  /** Before the divider and the Close button. */
  actions?: ReactNode;
  onClose(): void;
  children: ReactNode;
}) {
  const { onClose } = props;
  const drawerRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const before = document.activeElement;
    drawerRef.current?.focus();
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, []);
  return (
    <aside
      ref={drawerRef}
      tabIndex={-1}
      className={styles.drawer}
      aria-label={props.label}
      data-testid={props.testId}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        // A menu or tooltip in a portal still bubbles its keys here; that Escape is its own.
        if (!(e.target instanceof Node) || !e.currentTarget.contains(e.target))
          return;
        e.stopPropagation();
        onClose();
      }}
    >
      <header className={styles.header}>
        <h3 className={styles.title} title={props.title}>
          {props.title}
        </h3>
        <span className={styles.kind}>{props.kind}</span>
        {props.extra}
        <div className={styles.grow} />
        {props.actions}
        <span className={styles.divider} aria-hidden="true" />
        <IconButton
          label="Close details"
          icon={<X size={14} aria-hidden="true" />}
          onClick={onClose}
          data-testid={`${props.testId}-close`}
        />
      </header>
      {props.children}
    </aside>
  );
}
