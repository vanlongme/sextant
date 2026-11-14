import { RotateCcw } from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "../../design/Button";
import { Segmented } from "../../design/Segmented";
import { api } from "../../ipc/api";
import type { GraphNamespaceCount } from "../../ipc/generated/GraphNamespaceCount";
import { useGraph } from "../../stores/graph";
import { useUiState } from "../../stores/uiState";
import { useClusterContext } from "../cluster/ClusterLayout";
import styles from "./ClusterMapScreen.module.css";
import { graphTotal } from "./filters";
import { MapCanvas } from "./MapCanvas";
import { MapDetails } from "./MapDetails";
import { MapPanes } from "./MapPanes";
import {
  ALL_HIDDEN,
  MapEmpty,
  MapError,
  MapLoading,
  MapNote,
  NO_NODES,
  noMatchText,
  tooManyDrawnText,
} from "./MapStates";
import {
  autoHidden,
  buildModel,
  chipNamespaces,
  FORCE_MAX_NODES,
  levelSort,
  missingText,
  namespaceView,
  subscribedNamespaces,
  summaryText,
  summaryTitle,
  tooMany,
} from "./model";
import { objectMapPath } from "./paths";
import type { LayoutName } from "./scene";

export const FORCE_HINT =
  "Force works up to 400 resources. Hide some namespaces or kinds to use it.";

const LAYOUTS: { value: LayoutName; label: string }[] = [
  { value: "grouped", label: "Grouped" },
  { value: "layered", label: "Layered" },
  { value: "force", label: "Force" },
];

/** True when a node's name or kind contains the search text, ignoring case. */
export function matchesSearch(
  search: string,
  node: { name: string; kind: string },
): boolean {
  const q = search.trim().toLowerCase();
  return (
    node.name.toLowerCase().includes(q) || node.kind.toLowerCase().includes(q)
  );
}

/** The cluster map (spec E §9), at `cluster/:id/map`. */
export function ClusterMapScreen() {
  const { clusterId, resources } = useClusterContext();
  const navigate = useNavigate();
  const [savedHidden, setSavedHidden, hiddenLoaded] = useUiState<
    string[] | null
  >(`map.hidden.${clusterId}`, null);
  const [layout, setLayout] = useUiState<LayoutName>(
    `map.layout.${clusterId}`,
    "grouped",
  );
  const hidden = useMemo(() => new Set(savedHidden ?? []), [savedHidden]);
  // The last counts seen: the chips stay while a new filter loads.
  const [counts, setCounts] = useState<GraphNamespaceCount[] | null>(null);
  const chips = useMemo(() => chipNamespaces(counts ?? []), [counts]);
  // Until the namespaces are known, a saved choice subscribes with none of them.
  const filter = useMemo(
    () =>
      hidden.size === 0
        ? null
        : counts === null
          ? []
          : subscribedNamespaces(chips, hidden),
    [hidden, counts, chips],
  );
  const graph = useGraph(hiddenLoaded ? clusterId : null, filter);
  const snapshot = graph.snapshot;

  const [defaultNamespace, setDefaultNamespace] = useState<
    string | null | undefined
  >(undefined);
  useEffect(() => {
    let live = true;
    api.clusterSettingsGet(clusterId).then(
      (s) => live && setDefaultNamespace(s.defaultNamespace),
      () => live && setDefaultNamespace(null),
    );
    return () => {
      live = false;
    };
  }, [clusterId]);

  useEffect(() => {
    if (snapshot) setCounts(snapshot.counts);
  }, [snapshot]);

  // A cluster with no saved choice and more than 1,500 nodes keeps one namespace.
  useEffect(() => {
    if (!hiddenLoaded || savedHidden !== null || !snapshot) return;
    if (defaultNamespace === undefined) return;
    const auto = autoHidden(snapshot.counts, defaultNamespace);
    if (auto !== null) setSavedHidden(auto);
  }, [hiddenLoaded, savedHidden, snapshot, defaultNamespace, setSavedHidden]);

  const model = useMemo(
    () => (snapshot ? buildModel(snapshot.nodes, snapshot.edges) : null),
    [snapshot],
  );
  const ids = useMemo(
    () => (model ? namespaceView(model, hidden) : []),
    [model, hidden],
  );
  const total = useMemo(
    () => (model ? graphTotal(model, counts ?? []) : 0),
    [model, counts],
  );
  const filtering = chips.some((ns) => hidden.has(ns));
  const forceAllowed = ids.length <= FORCE_MAX_NODES;
  const drawnLayout: LayoutName =
    layout === "force" && !forceAllowed ? "grouped" : layout;

  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [centre, setCentre] = useState<{ id: string; n: number } | undefined>();
  const [resetSignal, setResetSignal] = useState(0);
  const shown = selected !== null && ids.includes(selected) ? selected : null;
  const searching = search.trim() !== "";
  const matches = useMemo(() => {
    if (!model || !searching) return [];
    return levelSort(
      model,
      ids.filter((id) => {
        const node = model.byId.get(id);
        return node !== undefined && matchesSearch(search, node);
      }),
    );
  }, [model, ids, search, searching]);

  const selectAndCentre = (id: string) => {
    setSelected(id);
    setCentre((c) => ({ id, n: (c?.n ?? 0) + 1 }));
  };

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || matches.length === 0) return;
    e.preventDefault();
    selectAndCentre(matches[0]);
  };

  const toggle = (namespace: string) => {
    const next = new Set(hidden);
    if (next.has(namespace)) next.delete(namespace);
    else next.add(namespace);
    setSavedHidden([...next].sort());
  };

  const allHidden = chips.length > 0 && chips.every((ns) => hidden.has(ns));

  let body: React.ReactNode;
  if (graph.error !== null) {
    body = <MapError message={graph.error} onRetry={graph.retry} />;
  } else if (!model) {
    body = <MapLoading />;
  } else if (allHidden) {
    body = <MapEmpty text={ALL_HIDDEN} />;
  } else if (tooMany(ids)) {
    body = <MapNote text={tooManyDrawnText(ids.length)} />;
  } else if (ids.length === 0) {
    body = <MapEmpty text={NO_NODES} />;
  } else {
    body = (
      <MapPanes
        canvas={
          <MapCanvas
            model={model}
            ids={ids}
            layout={drawnLayout}
            page="cluster"
            memoryKey={`${clusterId}|cluster|${drawnLayout}`}
            search={search}
            selected={shown}
            onSelect={setSelected}
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
              onSelect={selectAndCentre}
              onClose={() => setSelected(null)}
              onFocus={(id) => navigate(objectMapPath(clusterId, id))}
            />
          ) : null
        }
      />
    );
  }

  const drawing = model !== null && graph.error === null && !allHidden;
  return (
    <section className={styles.page} data-testid="map-page">
      <header className={styles.toolbar}>
        <h1 className={styles.title}>Resource map</h1>
        <input
          className={styles.search}
          type="search"
          placeholder="Find a resource"
          aria-label="Find a resource by name or kind"
          data-testid="map-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={onSearchKey}
        />
        <Segmented
          label="Layout"
          size="sm"
          value={drawnLayout}
          options={LAYOUTS.map((o) =>
            o.value === "force" && !forceAllowed
              ? { ...o, disabled: true, hint: FORCE_HINT }
              : o,
          )}
          onChange={setLayout}
          testId="map-layout"
        />
        {model ? (
          <span
            className={styles.summary}
            data-testid="map-summary"
            title={summaryTitle(filtering)}
          >
            {summaryText(model, ids, { total, filtering })}
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
      {chips.length > 0 ? (
        <div className={styles.chips}>
          {(counts ?? [])
            .filter((c) => c.namespace !== "")
            .sort((a, b) => a.namespace.localeCompare(b.namespace))
            .map((c) => (
              <button
                key={c.namespace}
                type="button"
                className={styles.chip}
                aria-pressed={!hidden.has(c.namespace)}
                data-testid={`map-ns-${c.namespace}`}
                onClick={() => toggle(c.namespace)}
              >
                {`${c.namespace} ${c.nodes.toLocaleString("en-US")}`}
              </button>
            ))}
        </div>
      ) : null}
      {drawing && snapshot && snapshot.missing.length > 0 ? (
        <MapNote text={missingText(snapshot.missing)} />
      ) : null}
      {drawing && searching && matches.length === 0 && !tooMany(ids) ? (
        <MapNote text={noMatchText(search)} />
      ) : null}
      <div className={styles.body}>{body}</div>
    </section>
  );
}
