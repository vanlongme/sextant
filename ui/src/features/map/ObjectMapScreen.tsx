import { ArrowLeft, RotateCcw } from "lucide-react";
import { useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { Button } from "../../design/Button";
import { Segmented } from "../../design/Segmented";
import { useUiState } from "../../stores/uiState";
import { useClusterContext } from "../cluster/ClusterLayout";
import styles from "./ClusterMapScreen.module.css";
import { idParts, parseDepth, useFocusMap } from "./focusMap";
import type { Depth } from "./layout/neighborhood";
import { MapCanvas } from "./MapCanvas";
import { MapDetails } from "./MapDetails";
import { MapPanes } from "./MapPanes";
import {
  goneText,
  MapEmpty,
  MapError,
  MapLoading,
  MapNote,
  tooManyText,
} from "./MapStates";
import { missingText, summaryText, tooMany } from "./model";
import { mapPath, objectMapPath } from "./paths";

type ObjectLayout = "grouped" | "layered";

const LAYOUTS: { value: ObjectLayout; label: string }[] = [
  { value: "grouped", label: "Grouped" },
  { value: "layered", label: "Layered" },
];

const DEPTHS: { value: "1" | "2" | "all"; label: string }[] = [
  { value: "1", label: "1 hop" },
  { value: "2", label: "2 hops" },
  { value: "all", label: "All" },
];

/** The location state of an object map: the earlier focuses, oldest first. */
export interface MapTrail {
  trail: string[];
}

/** The trail in a location state, or none when the state holds something else. */
export function trailOf(state: unknown): string[] {
  const trail = (state as Partial<MapTrail> | null)?.trail;
  return Array.isArray(trail) && trail.every((id) => typeof id === "string")
    ? trail
    : [];
}

/** The object map (spec E §10), at `cluster/:id/map?focus=‹id›`. */
export function ObjectMapScreen({ focusId }: { focusId: string }) {
  const { clusterId, resources } = useClusterContext();
  const navigate = useNavigate();
  const location = useLocation();
  const trail = trailOf(location.state);
  const depth = parseDepth(new URLSearchParams(location.search).get("depth"));
  const [layout, setLayout] = useUiState<ObjectLayout>(
    "map.objectLayout",
    "grouped",
  );
  const { graph, model, ids, gone } = useFocusMap(clusterId, focusId, depth);
  const snapshot = graph.snapshot;
  const focus = idParts(focusId);

  // The focus is selected on load, and again when the focus moves.
  const [picked, setPicked] = useState<{ focus: string; id: string | null }>({
    focus: focusId,
    id: focusId,
  });
  const selected = picked.focus === focusId ? picked.id : focusId;
  const select = (id: string | null) => setPicked({ focus: focusId, id });
  const [centre, setCentre] = useState<{ id: string; n: number } | undefined>();
  const [resetSignal, setResetSignal] = useState(0);
  const shown = selected !== null && ids.includes(selected) ? selected : null;

  const selectAndCentre = (id: string) => {
    select(id);
    setCentre((c) => ({ id, n: (c?.n ?? 0) + 1 }));
  };

  const setDepth = (value: Depth) => {
    navigate(objectMapPath(clusterId, focusId, value), {
      replace: true,
      state: location.state,
    });
  };

  const moveFocus = (id: string) => {
    const state: MapTrail = { trail: [...trail, focusId] };
    navigate(objectMapPath(clusterId, id), { state });
  };

  const previous = trail.length > 0 ? idParts(trail[trail.length - 1]) : null;

  let body: React.ReactNode;
  if (graph.error !== null) {
    body = <MapError message={graph.error} onRetry={graph.retry} />;
  } else if (!model) {
    body = <MapLoading />;
  } else if (gone) {
    body = (
      <MapEmpty text={goneText(focus.kind, focus.name)}>
        <Button
          size="sm"
          data-testid="map-to-cluster"
          onClick={() => navigate(mapPath(clusterId))}
        >
          Back to the cluster map
        </Button>
      </MapEmpty>
    );
  } else if (tooMany(ids)) {
    body = <MapNote text={tooManyText(ids.length)} />;
  } else {
    body = (
      <MapPanes
        canvas={
          <MapCanvas
            model={model}
            ids={ids}
            layout={layout}
            page="object"
            focusId={focusId}
            memoryKey={`${clusterId}|object|${focusId}|${layout}`}
            selected={shown}
            onSelect={select}
            resetSignal={resetSignal}
            centre={centre}
          />
        }
        details={
          shown !== null ? (
            <MapDetails
              model={model}
              id={shown}
              clusterId={clusterId}
              resources={resources}
              focusId={focusId}
              onSelect={selectAndCentre}
              onClose={() => select(null)}
              onFocus={moveFocus}
            />
          ) : null
        }
      />
    );
  }

  const drawing = model !== null && graph.error === null && !gone;
  return (
    <section
      className={styles.page}
      data-testid="map-page"
      data-focus={focusId}
    >
      <header className={styles.toolbar}>
        {previous !== null ? (
          <Button size="sm" data-testid="map-back" onClick={() => navigate(-1)}>
            <ArrowLeft size={14} aria-hidden="true" />
            {`Back to ${previous.kind} ${previous.name}`}
          </Button>
        ) : null}
        <div className={styles.titleBlock}>
          <h1 className={styles.title}>{focus.name}</h1>
          <span className={styles.subtitle}>{focus.kind}</span>
        </div>
        <Segmented
          label="Depth"
          size="sm"
          value={String(depth) as "1" | "2" | "all"}
          options={DEPTHS}
          onChange={(v) => setDepth(parseDepth(v))}
          testId="map-depth"
        />
        <Segmented
          label="Layout"
          size="sm"
          value={layout}
          options={LAYOUTS}
          onChange={setLayout}
          testId="map-layout"
        />
        {drawing && model ? (
          <span className={styles.summary} data-testid="map-summary">
            {summaryText(model, ids, false)}
          </span>
        ) : null}
        <Button
          size="sm"
          data-testid="map-reset"
          onClick={() => setResetSignal((n) => n + 1)}
        >
          <RotateCcw size={14} aria-hidden="true" />
          Reset layout
        </Button>
      </header>
      {drawing && snapshot && snapshot.missing.length > 0 ? (
        <MapNote text={missingText(snapshot.missing)} />
      ) : null}
      <div className={styles.body}>{body}</div>
    </section>
  );
}
