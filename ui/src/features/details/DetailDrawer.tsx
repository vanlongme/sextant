import { ChevronLeft, X } from "lucide-react";
import {
  type ReactElement,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
} from "react";
import {
  EmptyState,
  ErrorNotice,
  IconButton,
  Spinner,
  type TableColumn,
  Tabs,
} from "../../design";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import {
  DrawerLinkContext,
  type DrawerTarget,
  targetKey,
} from "../../kinds/detail/links";
import { DrawerKindContext } from "../../kinds/detail/parts";
import type { KubeObject } from "../../kinds/objects";
import { DRAWER_PANE, usePaneSize } from "../../stores/paneSize";
import { findResource } from "../../stores/resources";
import { DrawerMap, hasDrawerMap } from "../map/DrawerMap";
import { listLabel } from "../map/model";
import { DrawerMetrics } from "../metrics/DrawerMetrics";
import { metricsTargetOf } from "../metrics/targets";
import { DrawerObjectActions } from "../resources/DrawerObjectActions";
import { useKindColumns } from "../resources/kindColumns";
import styles from "./DetailDrawer.module.css";
import { DrawerResize } from "./DrawerResize";
import { OVERVIEW } from "./drawerHistory";
import { EventsSection } from "./EventsSection";
import { OverviewSections } from "./OverviewSections";
import type { DrawerHistoryApi } from "./useDrawerHistory";
import { type DrawerObject, useDrawerObject } from "./useDrawerObject";

const OVERVIEW_TAB = {
  value: OVERVIEW,
  label: "Overview",
  testId: "detail-tab-overview",
};
const METRICS_TAB = {
  value: "metrics",
  label: "Metrics",
  testId: "detail-tab-metrics",
};
const MAP_TAB = {
  value: "map",
  label: "Resource map",
  testId: "detail-tab-map",
};
const EVENTS_TAB = {
  value: "events",
  label: "Events",
  testId: "detail-tab-events",
};

/** The screen's own kind is served and listable, even when `resources` leaves it out. */
function ownInfo(resource: ResourceRef): ApiResourceInfo {
  return {
    resource,
    verbs: [],
    shortNames: [],
    canList: true,
    canWatch: true,
    canCreate: false,
    canUpdate: false,
    canPatch: false,
    canDelete: false,
  };
}

function Body(props: {
  clusterId: string;
  resource: ResourceRef;
  object: KubeObject;
  resources: ApiResourceInfo[];
  columns: readonly TableColumn<KubeObject>[];
  tab: string;
}) {
  const { clusterId, resource, object, resources, columns, tab } = props;
  // The overview stays mounted under the other tabs, so unsaved edits survive a
  // tab switch. The metrics panel polls and the map watches the cluster, so each is
  // mounted only while it is shown.
  return (
    <>
      {tab === "map" ? (
        <DrawerMap
          clusterId={clusterId}
          kind={resource.kind}
          namespace={object.metadata.namespace ?? ""}
          name={object.metadata.name}
        />
      ) : null}
      {tab === "events" ? (
        <EventsSection
          clusterId={clusterId}
          kind={resource.kind}
          object={object}
        />
      ) : null}
      {tab === "metrics" ? (
        <section className={styles.section} data-testid="detail-metrics">
          <DrawerMetrics
            clusterId={clusterId}
            resource={resource}
            object={object}
          />
        </section>
      ) : null}
      <div hidden={tab !== OVERVIEW}>
        <OverviewSections
          clusterId={clusterId}
          resource={resource}
          object={object}
          resources={resources}
          columns={columns}
        />
      </div>
    </>
  );
}

/** What the drawer shows in place of an object (spec H50). */
function StateNotice(props: {
  read: DrawerObject;
  kind: string;
  target: DrawerTarget;
}) {
  const { read, kind, target } = props;
  switch (read.status) {
    case "notFound":
      return (
        <div data-testid="detail-not-found">
          <EmptyState
            title={`${kind} not found`}
            body={
              target.namespace
                ? `There is no ${kind} ${target.name} in namespace ${target.namespace}.`
                : `There is no ${kind} ${target.name} in the cluster.`
            }
          />
        </div>
      );
    case "forbidden":
      return (
        <div className={styles.fetchError} data-testid="detail-forbidden">
          <ErrorNotice
            title={`No access to this ${kind}`}
            message={read.message ?? "You do not have permission to read it."}
          />
        </div>
      );
    case "notServed":
      return (
        <div className={styles.fetchError} data-testid="detail-not-served">
          <ErrorNotice
            title={`${kind} objects are not available`}
            message={
              read.message ?? "The cluster does not serve this resource type."
            }
          />
        </div>
      );
    case "loading":
      return <Spinner label="Loading details" />;
    default:
      // "error" shows its notice above; the others show the object.
      return null;
  }
}

export interface DetailDrawerProps {
  clusterId: string;
  /** The screen's resource. */
  resource: ResourceRef;
  history: DrawerHistoryApi;
  onClose(): void;
  resources?: ApiResourceInfo[];
  /** The screen's columns, for the Summary of its own objects. */
  columns?: readonly TableColumn<KubeObject>[];
  /** The header's actions for an object of the screen's resource. */
  actions?(object: KubeObject): ReactNode;
}

/**
 * The drawer of the object the history shows: the row the URL names, or an object a link
 * in it opened (spec H42–H53). It renders nothing while nothing is open. Links push onto
 * the history and Back pops it; both move focus into the drawer. Escape closes it and
 * hands focus back to what had it before.
 */
export function DetailDrawer(props: DetailDrawerProps): ReactElement | null {
  const { clusterId, resource, history, onClose } = props;
  const resources = props.resources ?? [];
  const drawerRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [drawerWidth, setDrawerWidth] = usePaneSize(DRAWER_PANE);
  const target = history.shown?.target ?? null;
  const open = target !== null;
  const own =
    target !== null &&
    target.group === resource.group &&
    target.plural === resource.plural;
  const screenInfo = useMemo(() => ownInfo(resource), [resource]);
  const listed = target
    ? findResource(resources, target.group, target.plural)
    : undefined;
  const info = listed ?? (own ? screenInfo : undefined);
  const lastSeen = target ? history.lastSeen(target) : null;
  const read = useDrawerObject(clusterId, info, target, lastSeen);
  const linkedColumns = useKindColumns(
    clusterId,
    own ? undefined : info,
    resources,
    target?.namespace ?? null,
  );
  const columns = own ? (props.columns ?? []) : linkedColumns;

  const { remember, open: openLink, step } = history;
  useEffect(() => {
    if (target && read.status === "live" && read.object) {
      remember(target, read.object);
    }
  }, [target, read.status, read.object, remember]);

  useEffect(() => {
    if (!open) return;
    const before = document.activeElement;
    drawerRef.current?.focus();
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, [open]);

  const shownKey = target ? targetKey(target) : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: another shown object starts at the top.
  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [shownKey]);
  // A link or Back removes the element that had focus (spec H20).
  const firstStep = useRef(step);
  useEffect(() => {
    if (step !== firstStep.current) drawerRef.current?.focus();
  }, [step]);

  const group = target?.group ?? "";
  const plural = target?.plural ?? "";
  const kindKey = useMemo(() => ({ group, plural }), [group, plural]);
  const links = useMemo(() => ({ open: openLink }), [openLink]);

  if (target === null) return null;

  const object = read.object;
  const entryResource = info?.resource;
  const kind = entryResource?.kind ?? lastSeen?.kind ?? target.plural;
  const name = object?.metadata.name ?? target.name;
  const metrics =
    read.status === "live" &&
    object !== null &&
    entryResource !== undefined &&
    metricsTargetOf(entryResource, object) !== null;
  // The Resource map is for the kinds an object map can focus on (spec E §11).
  const tabs = [
    OVERVIEW_TAB,
    ...(metrics ? [METRICS_TAB] : []),
    ...(entryResource && hasDrawerMap(entryResource) ? [MAP_TAB] : []),
    EVENTS_TAB,
  ];
  // Back restores the entry's tab, or the Overview when it is no longer offered.
  const wanted = history.shown?.tab ?? OVERVIEW;
  const tab = tabs.some((t) => t.value === wanted) ? wanted : OVERVIEW;

  let actions: ReactNode = null;
  if ((read.status === "live" || read.status === "fetched") && object) {
    if (own) actions = props.actions?.(object) ?? null;
    else if (info) {
      actions = (
        <DrawerObjectActions
          clusterId={clusterId}
          info={info}
          object={object}
        />
      );
    }
  }

  return (
    <aside
      ref={drawerRef}
      tabIndex={-1}
      className={styles.drawer}
      aria-label={`${kind} details`}
      data-testid="detail-drawer"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        // A menu opened from the header sits in a portal outside the drawer. React
        // still bubbles its keys here, but that Escape belongs to the menu.
        if (!(e.target instanceof Node) || !e.currentTarget.contains(e.target))
          return;
        e.stopPropagation();
        // Escape in a text box must not throw away what is being typed.
        if (e.target instanceof HTMLTextAreaElement) return;
        onClose();
      }}
      style={{ flexBasis: drawerWidth }}
    >
      <DrawerResize width={drawerWidth} onChange={setDrawerWidth} />
      <header className={styles.header}>
        {history.previous ? (
          <IconButton
            label={`Back to ${history.previous.target.name}`}
            icon={<ChevronLeft size={16} aria-hidden="true" />}
            onClick={history.back}
            data-testid="detail-back"
          />
        ) : null}
        <h3 className={styles.title} data-testid="detail-title" title={name}>
          {name}
        </h3>
        <span className={styles.kind} data-testid="detail-kind">
          {kind}
        </span>
        <div className={styles.grow} />
        {actions ? (
          <>
            {actions}
            <span className={styles.divider} aria-hidden="true" />
          </>
        ) : null}
        <IconButton
          label="Close details"
          icon={<X size={14} aria-hidden="true" />}
          onClick={onClose}
          data-testid="detail-close"
        />
      </header>
      {read.status === "deleted" ? (
        <p
          className={styles.removed}
          role="status"
          data-testid="detail-removed"
        >
          This {kind} was deleted. What is shown is how it last looked.
        </p>
      ) : null}
      {read.status === "fetched" ? (
        <p className={styles.staticNote} data-testid="detail-static-note">
          Not updated live: you cannot watch{" "}
          {listLabel(target.plural, entryResource?.kind)}.
        </p>
      ) : null}
      {read.status === "error" ? (
        <div className={styles.fetchError} data-testid="detail-fetch-error">
          <ErrorNotice
            title={
              object
                ? `Could not load the latest ${kind}`
                : `Could not load this ${kind}`
            }
            message={read.message ?? ""}
            onRetry={read.retry}
          />
        </div>
      ) : null}
      {object && entryResource ? (
        <DrawerLinkContext.Provider value={links}>
          <DrawerKindContext.Provider value={kindKey}>
            <Tabs value={tab} onChange={history.setTab} tabs={tabs} />
            <div ref={contentRef} className={styles.content}>
              <Body
                key={targetKey(target)}
                clusterId={clusterId}
                resource={entryResource}
                object={object}
                resources={resources}
                columns={columns}
                tab={tab}
              />
            </div>
          </DrawerKindContext.Provider>
        </DrawerLinkContext.Provider>
      ) : (
        <StateNotice read={read} kind={kind} target={target} />
      )}
    </aside>
  );
}
