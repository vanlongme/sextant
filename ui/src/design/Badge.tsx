import type { ReactNode } from "react";
import styles from "./Badge.module.css";

export type Tone = "ok" | "warn" | "danger" | "info" | "neutral";

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`${styles.badge} ${styles[tone]}`}>{children}</span>;
}
