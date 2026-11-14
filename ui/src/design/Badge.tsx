import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import styles from "./Badge.module.css";

export type Tone = "ok" | "warn" | "danger" | "info" | "neutral";

/**
 * A state on a soft pill. A label too long for its cell ends in an ellipsis, and the
 * full label is then the badge's title (spec H69).
 */
export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  const label = useRef<HTMLSpanElement>(null);
  const [title, setTitle] = useState<string | undefined>(undefined);
  // Measured after each render; the same value again does not render twice.
  useLayoutEffect(() => {
    const el = label.current;
    if (!el) return;
    setTitle(
      el.scrollWidth > el.clientWidth
        ? (el.textContent ?? undefined)
        : undefined,
    );
  });
  return (
    <span className={`${styles.badge} ${styles[tone]}`} title={title}>
      <span ref={label} className={styles.label}>
        {children}
      </span>
    </span>
  );
}
