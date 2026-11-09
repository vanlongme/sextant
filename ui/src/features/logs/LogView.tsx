import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type CSSProperties,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import type { Segment } from "./ansi";
import styles from "./LogsTab.module.css";
import type { LogBuffer, LogLineEntry } from "./logBuffer";
import type { SearchIndex } from "./logSearch";
import {
  type Mark,
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
/** Within this distance of the bottom, new lines keep the list at the bottom. */
const STICK_DISTANCE = 20;
const CUT_NOTE = " … cut at 64 KiB";

/** Scrolls the entry with `seq` to the middle. A new `nonce` repeats a jump to the same entry. */
export interface LogJump {
  seq: number;
  nonce: number;
}

function segmentStyle(s: Segment): CSSProperties | undefined {
  const style: CSSProperties = {};
  if (s.color) style.color = s.color;
  // A search mark draws its own background.
  if (s.background && s.mark === null) style.background = s.background;
  if (s.bold) style.fontWeight = 600;
  if (s.dim) style.opacity = 0.7;
  if (s.italic) style.fontStyle = "italic";
  if (s.underline) style.textDecoration = "underline";
  return Object.keys(style).length > 0 ? style : undefined;
}

function markClass(mark: Segment["mark"]): string | undefined {
  if (mark === "current") return styles.current;
  if (mark === "match") return styles.match;
  return undefined;
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
          <span
            key={key}
            className={markClass(s.mark)}
            style={segmentStyle(s)}
            data-mark={s.mark ?? undefined}
          >
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
  marks: Mark[];
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
        <Segments segments={paintLine(entry, props.marks)} />
        {entry.truncated ? (
          <span className={styles.cut}>{CUT_NOTE}</span>
        ) : null}
      </span>
    </>
  );
}

/**
 * The virtualized lines of a Logs tab. Rows are 20 px with Wrap off, and measured
 * with Wrap on. The buffer changes in place; `version` says when it did. While the
 * list is within 20 px of the bottom, new lines keep it there; scrolling up pauses
 * that, and the bottom or End resumes it. A jump pauses it too.
 */
export function LogView(props: {
  buffer: LogBuffer;
  version: number;
  timestamps: boolean;
  wrap: boolean;
  prefix: PrefixMode;
  /** Shown above the rows; null for none. */
  empty: string | null;
  search: SearchIndex;
  jump: LogJump | null;
}) {
  const { buffer, version, wrap, search, jump } = props;
  const scroller = useRef<HTMLDivElement>(null);
  /** Whether new lines keep the list at the bottom. */
  const stick = useRef(true);
  /** Where a jump scrolled to, so its own scroll event does not resume autoscroll. */
  const jumpTarget = useRef<number | null>(null);
  /** The offset last seen while shown: a hidden (display:none) panel loses its own. */
  const savedTop = useRef(0);
  /** The buffer as last drawn, to tell dropped lines from a clear. */
  const shown = useRef({ firstSeq: buffer.firstSeq, epoch: buffer.epoch });

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
  const totalSize = virtualizer.getTotalSize();

  // Rows wrap to new heights, or go back to one: measure them again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `wrap` says when the heights changed.
  useEffect(() => {
    virtualizer.measure();
  }, [wrap, virtualizer]);

  // New entries: stay at the bottom while stuck to it. Otherwise, when the oldest
  // lines are dropped, keep the lines on screen where they are.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when `version` says the buffer changed.
  useLayoutEffect(() => {
    const before = shown.current;
    shown.current = { firstSeq: buffer.firstSeq, epoch: buffer.epoch };
    const el = scroller.current;
    if (!el) return;
    if (before.epoch !== buffer.epoch) {
      stick.current = true;
      jumpTarget.current = null;
    }
    if (stick.current) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    const dropped = buffer.firstSeq - before.firstSeq;
    if (!wrap && dropped > 0) {
      el.scrollTop = Math.max(0, el.scrollTop - dropped * ROW_HEIGHT);
    }
  }, [version]);

  // Measured rows change the height without a new version.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the list's height changes.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [totalSize]);

  // A dock panel is hidden with display:none, which drops the scroll offset. When
  // the list shows again, go back to the bottom if stuck, else to where it was.
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let wasShown = el.clientHeight > 0;
    const observer = new ResizeObserver(() => {
      const shown = el.clientHeight > 0;
      if (shown && !wasShown) {
        el.scrollTop = stick.current ? el.scrollHeight : savedTop.current;
      }
      wasShown = shown;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const jumpSeq = jump?.seq;
  const jumpNonce = jump?.nonce;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a jump runs once per nonce.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || jumpSeq === undefined) return;
    const index = buffer.indexOf(jumpSeq);
    if (index === -1) return;
    const middle = wrap
      ? (virtualizer.getOffsetForIndex(index, "center")?.[0] ?? 0)
      : LIST_PADDING +
        index * ROW_HEIGHT +
        ROW_HEIGHT / 2 -
        el.clientHeight / 2;
    const top = Math.max(
      0,
      Math.min(middle, el.scrollHeight - el.clientHeight),
    );
    stick.current = false;
    jumpTarget.current = top;
    el.scrollTop = top;
  }, [jumpSeq, jumpNonce]);

  function onScroll(): void {
    const el = scroller.current;
    if (!el) return;
    if (el.clientHeight === 0) return;
    savedTop.current = el.scrollTop;
    if (
      jumpTarget.current !== null &&
      Math.abs(el.scrollTop - jumpTarget.current) <= 1
    ) {
      return;
    }
    jumpTarget.current = null;
    stick.current =
      el.scrollHeight - el.clientHeight - el.scrollTop <= STICK_DISTANCE;
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "End") return;
    event.preventDefault();
    const el = scroller.current;
    if (!el) return;
    stick.current = true;
    jumpTarget.current = null;
    el.scrollTop = el.scrollHeight;
  }

  const currentMatch = search.currentMatch;

  return (
    <div
      ref={scroller}
      className={styles.view}
      role="log"
      aria-label="Log lines"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the list scrolls with the keyboard, so it takes the focus.
      tabIndex={0}
      onScroll={onScroll}
      onKeyDown={onKeyDown}
      data-wrap={wrap}
      data-testid="logs-view"
    >
      {props.empty === null ? null : (
        <p className={styles.empty} data-testid="logs-empty">
          {props.empty}
        </p>
      )}
      <div className={styles.sizer} style={{ height: totalSize }}>
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
                  marks={search.on(entry.seq).map((m) => ({
                    start: m.start,
                    end: m.end,
                    current: m === currentMatch,
                  }))}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
