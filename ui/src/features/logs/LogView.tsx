import { useVirtualizer } from "@tanstack/react-virtual";
import { type CSSProperties, useCallback, useEffect, useRef } from "react";
import type { Segment } from "./ansi";
import styles from "./LogsTab.module.css";
import type { LogBuffer, LogLineEntry } from "./logBuffer";
import {
  markerText,
  type PrefixMode,
  paintLine,
  prefixColor,
  prefixText,
} from "./paint";

export const ROW_HEIGHT = 20;
/** Above the first row and below the last. */
export const LIST_PADDING = 6;
const OVERSCAN = 20;
const CUT_NOTE = " … cut at 64 KiB";

function segmentStyle(s: Segment): CSSProperties | undefined {
  const style: CSSProperties = {};
  if (s.color) style.color = s.color;
  if (s.background) style.background = s.background;
  if (s.bold) style.fontWeight = 600;
  if (s.dim) style.opacity = 0.7;
  if (s.italic) style.fontStyle = "italic";
  if (s.underline) style.textDecoration = "underline";
  return Object.keys(style).length > 0 ? style : undefined;
}

/** Text only: log text never goes through `innerHTML`. */
function Segments({ segments }: { segments: Segment[] }) {
  let at = 0;
  return (
    <>
      {segments.map((s) => {
        const key = at;
        at += s.text.length;
        return (
          <span key={key} style={segmentStyle(s)}>
            {s.text}
          </span>
        );
      })}
    </>
  );
}

function LineContent(props: {
  entry: LogLineEntry;
  timestamps: boolean;
  prefix: PrefixMode;
  order: number;
}) {
  const { entry } = props;
  const prefix = prefixText(props.prefix, entry.pod, entry.container);
  return (
    <>
      {props.timestamps && entry.timestamp ? (
        <span className={styles.time} data-testid="log-time">
          {entry.timestamp}
        </span>
      ) : null}
      {prefix === null ? null : (
        <span
          className={styles.prefix}
          style={{ color: prefixColor(props.order) }}
          title={`${entry.pod}/${entry.container}`}
          data-testid="log-prefix"
        >
          {prefix}
        </span>
      )}
      <span className={styles.text}>
        <Segments segments={paintLine(entry)} />
        {entry.truncated ? (
          <span className={styles.cut}>{CUT_NOTE}</span>
        ) : null}
      </span>
    </>
  );
}

/**
 * The virtualized lines of a Logs tab. Rows are 20 px with Wrap off, and measured
 * with Wrap on. The buffer changes in place; `version` says when it did.
 */
export function LogView(props: {
  buffer: LogBuffer;
  version: number;
  timestamps: boolean;
  wrap: boolean;
  prefix: PrefixMode;
  /** Shown above the rows; null for none. */
  empty: string | null;
}) {
  const { buffer, version, wrap } = props;
  const scroller = useRef<HTMLDivElement>(null);

  // Keys are the entries' `seq`, so the rows that stay keep their elements.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` says when the buffer changed.
  const getItemKey = useCallback(
    (index: number) => buffer.at(index)?.seq ?? index,
    [buffer, version],
  );
  const virtualizer = useVirtualizer({
    count: buffer.size,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey,
    overscan: OVERSCAN,
    paddingStart: LIST_PADDING,
    paddingEnd: LIST_PADDING,
  });

  // Rows wrap to new heights, or go back to one: measure them again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `wrap` says when the heights changed.
  useEffect(() => {
    virtualizer.measure();
  }, [wrap, virtualizer]);

  return (
    <div
      ref={scroller}
      className={styles.view}
      role="log"
      aria-label="Log lines"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the list scrolls with the keyboard, so it takes the focus.
      tabIndex={0}
      data-wrap={wrap}
      data-testid="logs-view"
    >
      {props.empty === null ? null : (
        <p className={styles.empty} data-testid="logs-empty">
          {props.empty}
        </p>
      )}
      <div
        className={styles.sizer}
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((item) => {
          const entry = buffer.at(item.index);
          if (!entry) return null;
          const marker = entry.kind === "marker";
          return (
            <div
              key={item.key}
              ref={wrap ? virtualizer.measureElement : undefined}
              data-index={item.index}
              data-seq={entry.seq}
              className={marker ? `${styles.row} ${styles.marker}` : styles.row}
              style={{ transform: `translateY(${item.start}px)` }}
              data-testid={marker ? "log-marker" : "log-line"}
            >
              {entry.kind === "marker" ? (
                markerText(entry)
              ) : (
                <LineContent
                  entry={entry}
                  timestamps={props.timestamps}
                  prefix={props.prefix}
                  order={buffer.podOrder(entry.pod)}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
