import { CircleX, Info, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import styles from "./Helm.module.css";

const ICONS = { warn: TriangleAlert, danger: CircleX, neutral: Info };

/** A one-line notice above a list or in a drawer, with an optional action. */
export function Notice(props: {
  tone: "warn" | "danger" | "neutral";
  children: ReactNode;
  action?: ReactNode;
  testId: string;
}) {
  const Icon = ICONS[props.tone];
  return (
    <div
      className={`${styles.notice} ${styles[props.tone]}`}
      role={props.tone === "neutral" ? "status" : "alert"}
      data-testid={props.testId}
    >
      <Icon size={14} aria-hidden="true" />
      <p className={styles.noticeText}>{props.children}</p>
      {props.action}
    </div>
  );
}
