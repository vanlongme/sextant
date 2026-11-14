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
import { bridgeEdges } from "./bridges";
import styles from "./ClusterMapScreen.module.css";
import {
  filtersActive,
  graphTotal,
  type KindGroup,
  kindGroups,
  kindView,
  visibleModel,
} from "./filters";
import { MapCanvas } from "./MapCanvas";
import { MapDetails } from "./MapDetails";
import { MapFilters } from "./MapFilters";
import { MapPanes } from "./MapPanes";
import {
  ALL_HIDDEN,
  ALL_KINDS_HIDDEN,
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

/** The cluster map (spec E §9, H §10), at `cluster/:id/map`. */
export function ClusterMapScreen() {
  const { clusterId, resources } = useClusterContext();
  const navigate = useNavigate();
  const [savedHidden, setSavedHidden, hiddenLoaded] = useUiState<
    string[] | null
  >(`map.hidden.${clusterId}`, null);
  const [savedKinds, setSavedKinds] = useUiState<string[]>(
    `map.hiddenKinds.${clusterId}`,
    [],
  );
  const [layout, setLayout] = useUiState<LayoutName>(
    `map.layout.${clusterId}`,
    "grouped",
  );
  const hidden = useMemo(() => new Set(savedHidden ?? []), [savedHidden]);
  const hiddenKinds = useMemo(() => new Set(savedKinds), [savedKinds]);
  // The last counts seen: the filters row stays while a new filter loads.
  const [counts, setCounts] = useState<GraphNamespaceCount[] | null>(null);
  const namespaces = useMemo(() => chipNamespaces(counts ?? []), [counts]);
  // Until the namespaces are known, a saved choice subscribes with none of them.
  const filter = useMemo(
    () =>
      hidden.size === 0
        ? null
        : counts === null
          ? []
          : subscribedNamespaces(namespaces, hidden),
    [hidden, counts, namespaces],
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

  // Spec H62, in order: the model, the namespace view, the kind view, the bridges, and
  // the drawn model.
  const model = useMemo(
    () => (snapshot ? buildModel(snapshot.nodes, snapshot.edges) : null),
    [snapshot],
  );
  const viewIds = useMemo(
    () => (model ? namespaceView(model, hidden) : []),
    [model, hidden],
  );
  const shownIds = useMemo(
    () => (model ? kindView(model, viewIds, hiddenKinds) : []),
    [model, viewIds, hiddenKinds],
  );
  const drawn = useMemo(() => {
    if (!model) return null;
    const kindHidden = shownIds.length < viewIds.length;
    const bridges = kindHidden
      ? bridgeEdges(model, viewIds, new Set(shownIds))
      : [];
    return visibleModel(model, shownIds, bridges);
  }, [model, viewIds, shownIds]);

  const liveGroups = useMemo(
    () => (model ? kindGroups(model, viewIds) : null),
    [model, viewIds],
  );
  // The last groups seen: the Kinds dropdown keeps its rows while a new filter loads.
  const [lastGroups, setLastGroups] = useState<KindGroup[]>([]);
  useEffect(() => {
    if (liveGroups) setLastGroups(liveGroups);
  }, [liveGroups]);
  const groups = liveGroups ?? lastGroups;

  const filtering = filtersActive(namespaces, hidden, groups, hiddenKinds);
  const total = useMemo(
    () => (model && snapshot ? graphTotal(model, snapshot.counts) : 0),
    [model, snapshot],
  );

  const forceAllowed = shownIds.length <= FORCE_MAX_NODES;
  const drawnLayout: LayoutName =
    layout === "force" && !forceAllowed ? "grouped" : layout;

  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [centre, setCentre] = useState<{ id: string; n: number } | undefined>();
  const [resetSignal, setResetSignal] = useState(0);
  // A selection whose node is no longer drawn is cleared, not kept for later (spec H67).
  useEffect(() => {
    if (drawn && selected !== null && !drawn.byId.has(selected)) {
      setSelected(null);
    }
  }, [drawn, selected]);
  const shown =
    selected !== null && drawn?.byId.has(selected) === true ? selected : null;
  const searching = search.trim() !== "";
  const matches = useMemo(() => {
    if (!drawn || !searching) return [];
    return levelSort(
      drawn,
      shownIds.filter((id) => {
        const node = drawn.byId.get(id);
        return node !== undefined && matchesSearch(search, node);
      }),
    );
  }, [drawn, shownIds, search, searching]);

  const selectAndCentre = (id: string) => {
    setSelected(id);
    setCentre((c) => ({ id, n: (c?.n ?? 0) + 1 }));
  };

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || matches.length === 0) return;
    e.preventDefault();
    selectAndCentre(matches[0]);
  };

  const allHidden =
    namespaces.length > 0 && namespaces.every((ns) => hidden.has(ns));
  const allKindsHidden = viewIds.length > 0 && shownIds.length === 0;

  let body: React.ReactNode;
  if (graph.error !== null) {
    body = <MapError message={graph.error} onRetry={graph.retry} />;
  } else if (drawn === null) {
    body = <MapLoading />;
  } else if (allHidden) {
    body = <MapEmpty text={ALL_HIDDEN} />;
  } else if (allKindsHidden) {
    body = <MapEmpty text={ALL_KINDS_HIDDEN} />;
  } else if (tooMany(shownIds)) {
    body = <MapNote text={tooManyDrawnText(shownIds.length)} />;
  } else if (shownIds.length === 0) {
    body = <MapEmpty text={NO_NODES} />;
  } else {
    body = (
      <MapPanes
        canvas={
          <MapCanvas
            model={drawn}
            ids={shownIds}
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
              model={drawn}
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

  const drawing =
    drawn !== null && graph.error === null && !allHidden && !allKindsHidden;
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
        <div className={styles.grow} />
        <Button
          size="sm"
          data-testid="map-reset"
          onClick={() => setResetSignal((n) => n + 1)}
        >
          <RotateCcw size={14} aria-hidden="true" />
          Reset layout
        </Button>
      </header>
      {counts !== null ? (
        <MapFilters
          counts={counts}
          hiddenNamespaces={savedHidden ?? []}
          onHiddenNamespacesChange={setSavedHidden}
          groups={groups}
          hiddenKinds={savedKinds}
          onHiddenKindsChange={setSavedKinds}
          summary={
            drawn ? summaryText(drawn, shownIds, { total, filtering }) : null
          }
          summaryTitle={summaryTitle(filtering)}
        />
      ) : null}
      {drawing && snapshot && snapshot.missing.length > 0 ? (
        <MapNote text={missingText(snapshot.missing)} />
      ) : null}
      {drawing && searching && matches.length === 0 && !tooMany(shownIds) ? (
        <MapNote text={noMatchText(search)} />
      ) : null}
      <div className={styles.body}>{body}</div>
    </section>
  );
}
