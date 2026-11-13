import { type KeyboardEvent, type PointerEvent, useRef } from "react";
import { Tooltip } from "../../design";
import { useWorkspace } from "../../stores/workspace";
import styles from "./WorkspaceScreen.module.css";

/** One Left or Right press moves the splitter by 2% of the width. */
const KEY_STEP = 0.02;

/**
 * The handle between pane `index` and the next one (spec E §15.3). Its value is the
 * left pane's share of the width, in percent.
 */
export function Splitter(props: { index: number; width: number }) {
  const { index, width } = props;
  const dispatch = useWorkspace((s) => s.dispatch);
  const drag = useRef<{ fromX: number; from: number; total: number } | null>(
    null,
  );

  function start(event: PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    const total =
      event.currentTarget.parentElement?.getBoundingClientRect().width ?? 0;
    if (total <= 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { fromX: event.clientX, from: width, total };
  }

  function move(event: PointerEvent<HTMLDivElement>): void {
    if (!drag.current) return;
    const { fromX, from, total } = drag.current;
    dispatch({
      type: "resize",
      index,
      fraction: from + (event.clientX - fromX) / total,
    });
  }

  function stop(): void {
    drag.current = null;
  }

  function key(event: KeyboardEvent<HTMLDivElement>): void {
    const step =
      event.key === "ArrowLeft"
        ? -KEY_STEP
        : event.key === "ArrowRight"
          ? KEY_STEP
          : 0;
    if (step === 0) return;
    event.preventDefault();
    dispatch({ type: "resize", index, fraction: width + step });
  }

  return (
    <Tooltip content="Drag to resize, double-click to make the panes equal">
      {/* biome-ignore lint/a11y/useSemanticElements: an hr cannot be dragged or focused. */}
      <div
        className={styles.splitter}
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize panes ${index + 1} and ${index + 2}`}
        aria-valuemin={24}
        aria-valuemax={76}
        aria-valuenow={Math.round(width * 100)}
        tabIndex={0}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={stop}
        onPointerCancel={stop}
        onDoubleClick={() => dispatch({ type: "equalize" })}
        onKeyDown={key}
        data-testid="workspace-splitter"
      />
    </Tooltip>
  );
}
