import { type ReactNode, useRef } from "react";
import { CopyButton } from "../../design";
import styles from "./DetailDrawer.module.css";

/**
 * One key and value of a drawer list, with a copy button at the end of the value.
 * It copies what the value cell shows, unless `copy` gives the text.
 */
export function CopyRow(props: {
  label: string;
  children: ReactNode;
  copy?: string;
  what?: string;
}) {
  const cell = useRef<HTMLSpanElement>(null);
  return (
    <div className={`${styles.copyHost} ${styles.copyRow}`}>
      <dt className={styles.key}>{props.label}</dt>
      <dd className={styles.copyValue}>
        <span ref={cell} className={styles.value}>
          {props.children}
        </span>
        <CopyButton
          className={styles.copy}
          what={props.what ?? props.label}
          value={() => props.copy ?? cell.current?.textContent ?? ""}
        />
      </dd>
    </div>
  );
}
