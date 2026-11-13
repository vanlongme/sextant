import { PaneHandle } from "../../design";
import { DRAWER_PANE } from "../../stores/paneSize";

/** The handle on a drawer's left border; the drawer keeps the width (`usePaneSize`). */
export function DrawerResize(props: {
  width: number;
  onChange(width: number): void;
}) {
  return (
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
}
