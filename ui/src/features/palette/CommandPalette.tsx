import { Search } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
import { useCommandContext } from "../../app/commands";
import { ShellDialog } from "../../app/ShellDialog";
import { IS_MAC } from "../../app/shortcuts";
import { api } from "../../ipc/api";
import { failureMessage } from "../../ipc/client";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { ObjectNames } from "../../ipc/generated/ObjectNames";
import { useCatalog } from "../../stores/catalog";
import { useShell } from "../../stores/shell";
import styles from "./CommandPalette.module.css";
import { isBlank } from "./fuzzy";
import {
  buildSections,
  clusterEntries,
  commandEntries,
  objectEntries,
  type PaletteEntry,
  type PaletteRow,
  pageEntries,
} from "./sections";

const LABEL = "Search clusters, pages, objects and commands";
const NO_RESOURCES: ApiResourceInfo[] = [];

/** What `resources_names` gave for one connected cluster. */
type Names =
  | { clusterId: string; status: "loading" }
  | { clusterId: string; status: "ready"; names: ObjectNames }
  | { clusterId: string; status: "failed"; message: string };

export function CommandPalette() {
  const open = useShell((s) => s.dialog === "palette");
  const close = useShell((s) => s.close);
  return (
    <ShellDialog
      open={open}
      onClose={() => close("palette")}
      label="Command palette"
      testId="palette"
      kind="palette"
    >
      <PaletteBody onDone={() => close("palette")} />
    </ShellDialog>
  );
}

/**
 * Discovery and names of the connected cluster, read once per connection while the
 * palette is open (spec C §6.5). An answer for a connection that has gone is
 * dropped.
 */
function useClusterData(clusterId: string | null): {
  resources: ApiResourceInfo[];
  names: Names | null;
} {
  const [resources, setResources] = useState<{
    clusterId: string;
    list: ApiResourceInfo[];
  } | null>(null);
  const [names, setNames] = useState<Names | null>(null);

  useEffect(() => {
    if (clusterId === null) return;
    let current = true;
    setNames({ clusterId, status: "loading" });
    api.resourcesDiscover(clusterId, false).then(
      (list) => {
        if (current) setResources({ clusterId, list });
      },
      // The sidebar shows a discovery failure; Pages keep Overview and the routes.
      () => {
        if (current) setResources({ clusterId, list: NO_RESOURCES });
      },
    );
    api.resourcesNames(clusterId).then(
      (value) => {
        if (current) setNames({ clusterId, status: "ready", names: value });
      },
      (error: unknown) => {
        if (current) {
          setNames({
            clusterId,
            status: "failed",
            message: failureMessage(error),
          });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [clusterId]);

  return {
    resources:
      resources !== null && resources.clusterId === clusterId
        ? resources.list
        : NO_RESOURCES,
    names: names !== null && names.clusterId === clusterId ? names : null,
  };
}

interface ObjectsView {
  objects: PaletteEntry[] | null;
  status: string | null;
  truncated: boolean;
}

function objectsView(
  clusterId: string | null,
  names: Names | null,
): ObjectsView {
  if (clusterId === null)
    return { objects: null, status: null, truncated: false };
  if (names === null || names.status === "loading") {
    return { objects: null, status: "Loading objects…", truncated: false };
  }
  if (names.status === "failed") {
    return {
      objects: null,
      status: `Could not load objects: ${names.message}`,
      truncated: false,
    };
  }
  return {
    objects: objectEntries(clusterId, names.names.items),
    status: null,
    truncated: names.names.truncated.length > 0,
  };
}

function PaletteBody({ onDone }: { onDone(): void }) {
  const ctx = useCommandContext();
  const catalog = useCatalog((s) => s.clusters);
  const connectedId =
    ctx.cluster?.state.status === "connected" ? ctx.cluster.id : null;
  const clusterName = ctx.cluster?.name ?? "";
  const { resources, names } = useClusterData(connectedId);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const listId = useId();

  const commands = useMemo(() => commandEntries(ctx, IS_MAC), [ctx]);
  const clusters = useMemo(() => clusterEntries(catalog), [catalog]);
  const pages = useMemo(
    () => (connectedId === null ? null : pageEntries(connectedId, resources)),
    [connectedId, resources],
  );
  const objects = useMemo(
    () => objectsView(connectedId, names),
    [connectedId, names],
  );
  const sections = useMemo(
    () =>
      buildSections({
        query,
        clusterName,
        commands,
        clusters,
        pages,
        objects: objects.objects,
        objectsStatus: objects.status,
      }),
    [query, clusterName, commands, clusters, pages, objects],
  );
  const rows = useMemo(() => sections.flatMap((s) => s.rows), [sections]);
  const active = rows.length === 0 ? -1 : Math.min(selected, rows.length - 1);
  const starts: number[] = [];
  let total = 0;
  for (const section of sections) {
    starts.push(total);
    total += section.rows.length;
  }

  useEffect(() => {
    if (active < 0) return;
    document
      .getElementById(`${listId}-option-${active}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, listId]);

  function run(row: PaletteRow): void {
    onDone();
    row.run(ctx);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (rows.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setSelected((active + step + rows.length) % rows.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (active >= 0) run(rows[active]);
    }
  }

  const querying = !isBlank(query);
  const empty = querying && rows.length === 0 && objects.status === null;

  return (
    <>
      <div className={styles.inputRow}>
        <Search size={16} aria-hidden="true" className={styles.searchIcon} />
        <input
          className={styles.query}
          role="combobox"
          aria-label={LABEL}
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={
            active >= 0 ? `${listId}-option-${active}` : undefined
          }
          placeholder={LABEL}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(0);
          }}
          onKeyDown={onKeyDown}
          autoComplete="off"
          spellCheck={false}
          data-testid="palette-input"
        />
        <kbd className={styles.chip}>Esc</kbd>
      </div>
      {empty ? (
        <p className={styles.empty} data-testid="palette-empty">
          {`Nothing matches "${query.trim()}". Try a cluster, a kind such as Pods, an object name or a command.`}
        </p>
      ) : (
        <div
          id={listId}
          role="listbox"
          aria-label="Results"
          className={styles.results}
          data-testid="palette-results"
        >
          {sections.map((section, s) => (
            // biome-ignore lint/a11y/useSemanticElements: a fieldset brings a border and a legend that a result section does not want.
            <div
              key={section.id}
              role="group"
              aria-labelledby={`${listId}-${section.id}`}
              data-testid={`palette-section-${section.id}`}
            >
              <div id={`${listId}-${section.id}`} className={styles.heading}>
                {section.heading}
              </div>
              {section.rows.map((row, r) => {
                const at = starts[s] + r;
                return (
                  <Row
                    key={row.key}
                    row={row}
                    id={`${listId}-option-${at}`}
                    selected={at === active}
                    onSelect={() => setSelected(at)}
                    onRun={() => run(row)}
                  />
                );
              })}
              {section.status !== undefined ? (
                <div
                  role="option"
                  aria-selected={false}
                  aria-disabled="true"
                  tabIndex={-1}
                  className={styles.status}
                  data-testid="palette-objects-status"
                >
                  {section.status}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
      <div className={styles.footer}>
        <span>↑ ↓ to move</span>
        <span>Enter to run</span>
        {querying && objects.truncated ? (
          <span data-testid="palette-truncated">
            Objects: first 2,000 of each kind
          </span>
        ) : null}
        <span className={styles.count} data-testid="palette-count">
          {rows.length === 1 ? "1 result" : `${rows.length} results`}
        </span>
      </div>
    </>
  );
}

function Row(props: {
  row: PaletteRow;
  id: string;
  selected: boolean;
  onSelect(): void;
  onRun(): void;
}) {
  const { row } = props;
  const Icon = row.icon;
  return (
    <div
      id={props.id}
      role="option"
      aria-selected={props.selected}
      tabIndex={-1}
      className={styles.row}
      data-testid={row.testId}
      onMouseMove={props.selected ? undefined : props.onSelect}
      // Keeps the focus in the input.
      onMouseDown={(event) => event.preventDefault()}
      onClick={props.onRun}
      onKeyDown={(event) => {
        if (event.key === "Enter") props.onRun();
      }}
    >
      <Icon size={16} aria-hidden="true" className={styles.icon} />
      <span className={styles.label}>
        <Highlighted text={row.label} ranges={row.ranges} />
      </span>
      <span className={styles.hint}>{row.hint}</span>
    </div>
  );
}

function Highlighted(props: { text: string; ranges: [number, number][] }) {
  const { text } = props;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of props.ranges) {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(
      <mark key={start} className={styles.match}>
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}
