import { Columns3 } from "lucide-react";
import { useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import {
  Badge,
  Button,
  CheckMenu,
  EmptyState,
  ErrorNotice,
  Input,
  Spinner,
  type TableColumn,
  type TableSort,
  VirtualTable,
} from "../../design";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import { BUILTIN_GROUPS, groupFromSegment } from "../../kinds/nav";
import { type KubeObject, objectKey } from "../../kinds/objects";
import { columnsFromCrd } from "../../kinds/printerColumns";
import { defaultColumns, kindSpec } from "../../kinds/registry";
import { findResource, useResourceList } from "../../stores/resources";
import { useUiState } from "../../stores/uiState";
import { useClusterContext } from "../cluster/ClusterLayout";
import { DetailDrawer, type SummaryItem } from "../details/DetailDrawer";
import { DeleteDialog } from "./DeleteDialog";
import { matchesSearch } from "./filter";
import { NamespaceFilter, namespaceFilterKey } from "./NamespaceFilter";
import { ObjectActionBar } from "./ObjectActionBar";
import { objectActions } from "./objectActions";
import { RowActions, useActionContext } from "./ResourceActions";
import styles from "./ResourceScreen.module.css";

const ACTIONS_COLUMN = "actions";
/** Always shown, so a row can always be told apart. */
/** Shown in the drawer's own sections already. */
const SUMMARY_SKIP: ReadonlySet<string> = new Set([
  "name",
  "namespace",
  "age",
  ACTIONS_COLUMN,
]);
const FIXED_COLUMNS: ReadonlySet<string> = new Set(["name", ACTIONS_COLUMN]);

/** A choice made in the columns menu, which wins over the column's default. */
type ColumnChoices = Record<string, "shown" | "hidden">;

function rowTestId(o: KubeObject): string {
  const { namespace, name } = o.metadata;
  return namespace
    ? `resource-row-${namespace}-${name}`
    : `resource-row-${name}`;
}

/**
 * The definition of a custom resource, kept up to date. It is undefined for
 * built-in kinds, and while or when definitions cannot be listed.
 */
function useCustomResourceDefinition(
  clusterId: string,
  info: ApiResourceInfo,
  resources: ApiResourceInfo[],
): KubeObject | undefined {
  const { group, plural } = info.resource;
  const crds = findResource(
    resources,
    "apiextensions.k8s.io",
    "customresourcedefinitions",
  );
  const watchable =
    !BUILTIN_GROUPS.has(group) && crds?.canList && crds.canWatch;
  const list = useResourceList(clusterId, watchable ? crds.resource : null);
  const name = `${plural}.${group}`;
  return list.items.find((o) => o.metadata.name === name);
}

function kindColumns(
  info: ApiResourceInfo,
  crd: KubeObject | undefined,
): TableColumn<KubeObject>[] {
  const { resource } = info;
  const registered = kindSpec(resource.group, resource.plural)?.columns;
  if (registered) return registered(info);
  const printer = columnsFromCrd(crd, resource.version);
  if (printer.length === 0) return defaultColumns(resource);
  return [
    ...defaultColumns(resource).filter((c) => c.id !== "age"),
    ...printer,
  ];
}

function emptyText(kind: string, namespaced: boolean, namespaces: string[]) {
  if (!namespaced) return `This cluster has no ${kind} objects.`;
  if (namespaces.length === 0)
    return `There are no ${kind} objects in any namespace.`;
  const names = namespaces.join(", ");
  return `There are no ${kind} objects in namespace${namespaces.length > 1 ? "s" : ""} ${names}.`;
}

/** The table of one resource type. Give it a `key` so another type starts afresh. */
export function ResourceScreen(props: {
  clusterId: string;
  info: ApiResourceInfo;
  resources: ApiResourceInfo[];
}) {
  const { clusterId, info, resources } = props;
  const { resource, canDelete } = info;
  const { kind, namespaced } = resource;

  const list = useResourceList(clusterId, resource);
  const crd = useCustomResourceDefinition(clusterId, info, resources);
  const { context, confirmDialog } = useActionContext(clusterId, resource);

  const [params, setParams] = useSearchParams();
  const openKey = params.get("object");
  const [search, setSearch] = useState("");
  // Kept here because the table unmounts while no row matches.
  const [sort, setSort] = useState<TableSort | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [deleting, setDeleting] = useState<KubeObject[] | null>(null);
  const [savedNamespaces, setNamespaces] = useUiState<string[]>(
    namespaceFilterKey(clusterId),
    [],
  );
  const [choices, setChoices] = useUiState<ColumnChoices>(
    `columns:${resource.group}/${resource.plural}`,
    {},
  );
  const namespaces = namespaced ? savedNamespaces : [];

  const allNamespaces = useMemo(() => {
    const found = new Set<string>();
    for (const o of list.items) {
      if (o.metadata.namespace) found.add(o.metadata.namespace);
    }
    return [...found];
  }, [list.items]);

  const rows = useMemo(() => {
    const allowed = new Set(namespaces);
    return list.items.filter(
      (o) =>
        (allowed.size === 0 || allowed.has(o.metadata.namespace ?? "")) &&
        matchesSearch(o, search),
    );
  }, [list.items, namespaces, search]);

  const columns = useMemo<TableColumn<KubeObject>[]>(() => {
    const actions = kindSpec(resource.group, resource.plural)?.actions ?? [];
    return [
      ...kindColumns(info, crd),
      {
        id: ACTIONS_COLUMN,
        header: "Actions",
        width: 72,
        render: (o) => (
          <RowActions
            object={o}
            actions={actions}
            context={context}
            info={info}
            onDelete={(object) => setDeleting([object])}
          />
        ),
      },
    ];
  }, [info, crd, resource, context]);

  const kindActions = kindSpec(resource.group, resource.plural)?.actions ?? [];

  const isHidden = (c: TableColumn<KubeObject>) =>
    choices[c.id] ? choices[c.id] === "hidden" : Boolean(c.defaultHidden);
  const hiddenColumns = columns.filter(isHidden).map((c) => c.id);

  // Only what is on screen is deleted, so a search cannot hide part of a bulk delete.
  const selectedRows = rows.filter((o) => selected.has(objectKey(o)));

  const openObject = (key: string | null) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (key === null) next.delete("object");
        else next.set("object", key);
        return next;
      },
      { replace: false },
    );

  const opened =
    openKey === null
      ? undefined
      : list.items.find((o) => objectKey(o) === openKey);
  const summary: SummaryItem[] = opened
    ? columns
        .filter((c) => !SUMMARY_SKIP.has(c.id))
        .map((c) => ({ id: c.id, label: c.header, value: c.render(opened) }))
    : [];

  if (list.status === "notServed" || list.status === "forbidden") {
    return (
      <div className={styles.screen}>
        <h2 className={styles.title} data-testid="resource-title">
          {kind}
        </h2>
        <div data-testid="resource-status">
          {list.status === "forbidden" ? (
            <ErrorNotice
              title={`No access to ${kind} objects`}
              message={
                list.message ?? "You do not have permission to list these."
              }
            />
          ) : (
            <ErrorNotice
              title={`${kind} objects are not available`}
              message={
                list.message ??
                "The cluster no longer serves this resource type."
              }
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.screen}>
      <div className={styles.toolbar}>
        <h2 className={styles.title} data-testid="resource-title">
          {kind}
        </h2>
        <Input
          aria-label="Search by name, namespace or label"
          placeholder="Search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          data-testid="resource-search"
        />
        {namespaced ? (
          <NamespaceFilter
            namespaces={allNamespaces}
            selected={namespaces}
            onChange={setNamespaces}
          />
        ) : null}
        <CheckMenu
          trigger={
            <Button size="sm" aria-haspopup="menu" data-testid="columns-menu">
              <Columns3 size={14} aria-hidden="true" />
              Columns
            </Button>
          }
          items={columns
            .filter((c) => !FIXED_COLUMNS.has(c.id))
            .map((c) => ({
              id: c.id,
              label: c.header,
              checked: !isHidden(c),
              testId: `column-option-${c.id}`,
              onToggle: () =>
                setChoices({
                  ...choices,
                  [c.id]: isHidden(c) ? "shown" : "hidden",
                }),
            }))}
        />
        {list.status === "reconnecting" ? (
          <span
            className={styles.status}
            title={list.message ?? undefined}
            role="status"
            data-testid="resource-status"
          >
            <Badge tone="warn">Reconnecting</Badge>
          </span>
        ) : null}
        <div className={styles.grow} />
        <Button
          size="sm"
          variant="danger"
          disabled={!canDelete || selectedRows.length === 0}
          title={canDelete ? undefined : "You may not delete these objects."}
          onClick={() => setDeleting(selectedRows)}
          data-testid="bulk-delete"
        >
          Delete{selectedRows.length > 0 ? ` (${selectedRows.length})` : ""}
        </Button>
      </div>

      <div className={styles.body}>
        <div className={styles.main}>
          {list.loading ? (
            <Spinner label={`Loading ${kind} objects`} />
          ) : rows.length === 0 ? (
            <EmptyState
              title={`No ${kind} objects`}
              body={
                search.trim() !== ""
                  ? `No ${kind} objects match "${search.trim()}".`
                  : emptyText(kind, namespaced, namespaces)
              }
            />
          ) : (
            <VirtualTable
              rows={rows}
              columns={columns}
              rowKey={objectKey}
              rowTestId={rowTestId}
              rowLabel={(o) =>
                o.metadata.namespace
                  ? `${o.metadata.namespace}/${o.metadata.name}`
                  : o.metadata.name
              }
              hiddenColumns={hiddenColumns}
              sort={sort}
              onSortChange={setSort}
              selected={selected}
              onSelectedChange={setSelected}
              testId="resource-table"
              onRowClick={(o) => openObject(objectKey(o))}
              activeKey={openKey ?? undefined}
            />
          )}
        </div>
        <DetailDrawer
          clusterId={clusterId}
          resource={resource}
          objectKey={openKey}
          onClose={() => openObject(null)}
          resources={resources}
          summary={summary}
          actions={(object) => (
            <ObjectActionBar
              items={objectActions({
                object,
                kindActions,
                info,
                context,
                onDelete: (o) => setDeleting([o]),
              })}
            />
          )}
        />
      </div>

      {deleting ? (
        <DeleteDialog
          clusterId={clusterId}
          resource={resource}
          objects={deleting}
          onCancel={() => setDeleting(null)}
          onDeleted={(keys) => {
            setDeleting(null);
            const gone = new Set(keys);
            setSelected((s) => new Set([...s].filter((k) => !gone.has(k))));
          }}
        />
      ) : null}
      {confirmDialog}
    </div>
  );
}

/** The route of one resource list in a connected cluster. */
export function ResourceRoute() {
  const { group = "", plural = "" } = useParams();
  const { clusterId, resources, resourcesLoading, resourcesError } =
    useClusterContext();
  const info = findResource(resources, groupFromSegment(group), plural);
  if (info) {
    return (
      <ResourceScreen
        key={`${clusterId}/${group}/${plural}`}
        clusterId={clusterId}
        info={info}
        resources={resources}
      />
    );
  }
  if (resourcesLoading) return <Spinner label="Loading resources" />;
  return (
    <div className={styles.screen} data-testid="resource-status">
      {resourcesError ? (
        <ErrorNotice
          title="Could not load resources"
          message={resourcesError}
        />
      ) : (
        <EmptyState
          title="Resource not available"
          body="This cluster does not serve this resource."
        />
      )}
    </div>
  );
}
