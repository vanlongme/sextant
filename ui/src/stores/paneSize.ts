import { useUiState } from "./uiState";

/** A pane whose width the user drags, kept between runs under `key`. */
export interface PaneSize {
  key: string;
  initial: number;
  min: number;
  max: number;
}

/** The cluster navigation; its bounds are the boards'. */
export const NAV_PANE: PaneSize = {
  key: "layout.navWidth",
  initial: 220,
  min: 168,
  max: 360,
};

/** The details drawer of a resource list or a port forward; every drawer shares it. */
export const DRAWER_PANE: PaneSize = {
  key: "layout.drawerWidth",
  initial: 420,
  min: 320,
  max: 760,
};

/** The pane's width, within its bounds, and the setter that saves it. */
export function usePaneSize(pane: PaneSize): [number, (width: number) => void] {
  const [saved, save] = useUiState<number>(pane.key, pane.initial);
  const width =
    typeof saved === "number" && Number.isFinite(saved)
      ? Math.min(pane.max, Math.max(pane.min, Math.round(saved)))
      : pane.initial;
  return [width, save];
}
