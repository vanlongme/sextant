import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useState,
} from "react";
import styles from "./MapPanes.module.css";

/** The details pane's width: resizable from 260 to 520px, 320px at first (spec E §9.3). */
export const DETAILS_MIN = 260;
export const DETAILS_MAX = 520;
export const DETAILS_START = 320;
const KEY_STEP = 16;

const clampWidth = (w: number) =>
  Math.max(DETAILS_MIN, Math.min(DETAILS_MAX, w));

/** The canvas filling the page, and the details pane on the right while there is one. */
export function MapPanes({
  canvas,
  details,
}: {
  canvas: ReactNode;
  details: ReactNode | null;
}) {
  const [width, setWidth] = useState(DETAILS_START);

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const onMove = (ev: globalThis.PointerEvent) => {
      setWidth(clampWidth(startWidth - (ev.clientX - startX)));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft") setWidth((w) => clampWidth(w + KEY_STEP));
    else if (e.key === "ArrowRight") setWidth((w) => clampWidth(w - KEY_STEP));
    else return;
    e.preventDefault();
  };

  return (
    <div className={styles.panes}>
      <div className={styles.canvas}>{canvas}</div>
      {details !== null ? (
        <>
          {/* biome-ignore lint/a11y/useSemanticElements: an hr cannot be focused and dragged. */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the details"
            aria-valuemin={DETAILS_MIN}
            aria-valuemax={DETAILS_MAX}
            aria-valuenow={width}
            tabIndex={0}
            className={styles.handle}
            data-testid="map-details-resize"
            onPointerDown={onPointerDown}
            onKeyDown={onKeyDown}
          />
          <div className={styles.details} style={{ width }}>
            {details}
          </div>
        </>
      ) : null}
    </div>
  );
}
