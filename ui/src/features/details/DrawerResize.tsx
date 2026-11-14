import { PaneHandle } from "../../design";
import { DRAWER_PANE } from "../../stores/paneSize";

/**
 * The handle on a drawer's left border; the drawer keeps the width (`usePaneSize`).
 * `className` wraps it in a positioned box, as the overlay does to inset it (spec H17).
 */
export function DrawerResize(props: {
  width: number;
  onChange(width: number): void;
  className?: string;
}) {
  const handle = (
    <PaneHandle
      label="Resize details"
      edge="left"
      value={props.width}
      min={DRAWER_PANE.min}
      max={DRAWER_PANE.max}
      initial={DRAWER_PANE.initial}
      onChange={props.onChange}
      testId="drawer-resize"
    />
  );
  return props.className ? (
    <div className={props.className}>{handle}</div>
  ) : (
    handle
  );
}
