import { type KeyboardEvent, type PointerEvent, useRef, useState } from "react";
import styles from "./PaneHandle.module.css";

/** One arrow press moves the edge this far; with Shift, four times as far. */
const KEY_STEP = 16;

/**
 * The drag handle on the side edge of a pane, as the boards draw it: drag it, use Left and
 * Right (Shift for bigger steps), Home and End for the bounds, double-click to reset.
 * `edge` is the side of the pane the handle sits on, so on a left edge, Left widens the pane.
 * The parent places it: it fills the height of its nearest positioned ancestor, on `edge`.
 */
export function PaneHandle(props: {
  label: string;
  edge: "left" | "right";
  value: number;
  min: number;
  max: number;
  initial: number;
  onChange(width: number): void;
  testId?: string;
}) {
  const { edge, value, min, max, initial, onChange } = props;
  const sign = edge === "right" ? 1 : -1;
  const drag = useRef<{ fromX: number; from: number } | null>(null);
  const [active, setActive] = useState(false);
  const set = (width: number) =>
    onChange(Math.round(Math.min(max, Math.max(min, width))));

  function start(event: PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { fromX: event.clientX, from: value };
    setActive(true);
  }

  function move(event: PointerEvent<HTMLDivElement>): void {
    if (!drag.current) return;
    const { fromX, from } = drag.current;
    set(from + (event.clientX - fromX) * sign);
  }

  function stop(): void {
    drag.current = null;
    setActive(false);
  }

  function key(event: KeyboardEvent<HTMLDivElement>): void {
    const step = event.shiftKey ? KEY_STEP * 4 : KEY_STEP;
    if (event.key === "ArrowLeft") set(value - step * sign);
    else if (event.key === "ArrowRight") set(value + step * sign);
    else if (event.key === "Home") set(min);
    else if (event.key === "End") set(max);
    else return;
    event.preventDefault();
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: an hr cannot be dragged or focused.
    <div
      className={`${styles.handle} ${edge === "right" ? styles.right : styles.left}`}
      role="separator"
      aria-label={props.label}
      aria-orientation="vertical"
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      data-active={active}
      title="Drag to resize, double-click to reset"
      tabIndex={0}
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={stop}
      onPointerCancel={stop}
      onDoubleClick={() => set(initial)}
      onKeyDown={key}
      data-testid={props.testId}
    >
      <span className={styles.line} />
    </div>
  );
}
