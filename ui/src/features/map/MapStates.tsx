import type { ReactNode } from "react";
import { Button } from "../../design/Button";
import { Spinner } from "../../design/Spinner";
import styles from "./MapStates.module.css";

/** Waiting for the first snapshot (spec E §17). */
export function MapLoading() {
  return (
    <div className={styles.block} data-testid="map-loading">
      <Spinner label="Reading resources…" />
    </div>
  );
}

/** A `failure` event, or a subscribe call that failed. */
export function MapError({
  message,
  onRetry,
}: {
  message: string;
  onRetry(): void;
}) {
  return (
    <div className={styles.block} role="alert" data-testid="map-error">
      <p className={styles.text}>{`The map could not be built: ${message}`}</p>
      <Button data-testid="map-retry" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

/** Nothing to draw, with an optional action. */
export function MapEmpty({
  text,
  children,
}: {
  text: string;
  children?: ReactNode;
}) {
  return (
    <div className={styles.block} data-testid="map-empty">
      <p className={styles.text}>{text}</p>
      {children}
    </div>
  );
}

/** A note above the canvas, or in place of it when too much is shown. */
export function MapNote({ text }: { text: string }) {
  return (
    <p className={styles.note} role="note" data-testid="map-note">
      {text}
    </p>
  );
}

export const NO_NODES = "No resources in the selected namespaces.";
export const ALL_HIDDEN =
  "All namespaces are hidden. Pick one above to draw the map.";
export const ALL_KINDS_HIDDEN =
  "All kinds are hidden. Pick one in Kinds to draw the map.";

/** The cluster map's cap, which counts the drawn nodes after the Kinds filter. */
export function tooManyDrawnText(n: number): string {
  return `${n.toLocaleString("en-US")} resources in the selected namespaces and kinds. Hide some namespaces or kinds to draw the map.`;
}

/** "1,742 resources in the selected namespaces. Hide some namespaces to draw the map." */
export function tooManyText(n: number): string {
  return `${n.toLocaleString("en-US")} resources in the selected namespaces. Hide some namespaces to draw the map.`;
}

/** "No resource matches “web”." */
export function noMatchText(search: string): string {
  return `No resource matches “${search.trim()}”.`;
}

/** "Deployment web no longer exists." */
export function goneText(kind: string, name: string): string {
  return `${kind} ${name} no longer exists.`;
}
