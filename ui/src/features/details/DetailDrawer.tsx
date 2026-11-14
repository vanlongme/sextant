import { X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
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
import { DrawerKindContext } from "../../kinds/detail/parts";
import { type KubeObject, objectKey } from "../../kinds/objects";
import { DRAWER_PANE, usePaneSize } from "../../stores/paneSize";
import { rowsAreTrimmed, useResourceList } from "../../stores/resources";
import { DrawerMap, hasDrawerMap } from "../map/DrawerMap";
import { DrawerMetrics } from "../metrics/DrawerMetrics";
import { metricsTargetOf } from "../metrics/targets";
import styles from "./DetailDrawer.module.css";
import { DrawerResize } from "./DrawerResize";
import { EventsSection } from "./EventsSection";
import { OverviewSections } from "./OverviewSections";
import { useWholeObject } from "./useWholeObject";

const OVERVIEW_TAB = {
  value: "overview",
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

function Body(props: {
  clusterId: string;
  resource: ResourceRef;
  object: KubeObject;
  resources: ApiResourceInfo[];
  columns: readonly TableColumn<KubeObject>[];
  tab: string;
}) {
  const { clusterId, resource, object, resources, columns, tab } = props;
  const { group, plural } = resource;
  const kind = useMemo(() => ({ group, plural }), [group, plural]);
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
      <div hidden={tab !== "overview"}>
        <DrawerKindContext.Provider value={kind}>
          <OverviewSections
            clusterId={clusterId}
            resource={resource}
            object={object}
            resources={resources}
            columns={columns}
          />
        </DrawerKindContext.Provider>
      </div>
    </>
  );
}

/**
 * The right-hand drawer of one object, kept up to date from the resource's live list.
 * When that list holds trimmed rows (Pods), it shows the object from `resourceGet`
 * instead, fetched again each time the row's `resourceVersion` changes. A deleted
 * object stays as it last looked, with a notice.
 * It renders nothing without an `objectKey` (`<namespace>/<name>`). Escape closes it
 * and hands focus back to what had it before. `resources` lets owners link to their
 * lists, and `columns` are the kind's table columns, for the Summary. `actions` renders the header's
 * action bar. Opening moves focus to the drawer itself.
 */
export function DetailDrawer(props: {
  clusterId: string;
  resource: ResourceRef;
  objectKey: string | null;
  onClose(): void;
  resources?: ApiResourceInfo[];
  columns?: readonly TableColumn<KubeObject>[];
  /** The header's actions for the object shown; called only while it is in the live list. */
  actions?(object: KubeObject): ReactNode;
}) {
  const { clusterId, resource, objectKey: wanted, onClose } = props;
  const list = useResourceList(clusterId, resource);
  const [tab, setTab] = useState("overview");
  const drawerRef = useRef<HTMLElement>(null);
  const lastSeen = useRef<{ key: string; object: KubeObject } | null>(null);
  const [drawerWidth, setDrawerWidth] = usePaneSize(DRAWER_PANE);
  const open = wanted !== null;

  // Another object starts on its overview, with no render showing the old tab.
  const [tabOwner, setTabOwner] = useState(wanted);
  if (tabOwner !== wanted) {
    setTabOwner(wanted);
    setTab("overview");
  }

  useEffect(() => {
    if (!open) return;
    const before = document.activeElement;
    drawerRef.current?.focus();
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, [open]);

  const found =
    wanted === null
      ? undefined
      : list.items.find((o) => objectKey(o) === wanted);
  // A trimmed row lacks what the drawer shows, so the drawer shows the fetched object.
  const whole = useWholeObject(clusterId, resource, wanted, found);

  if (wanted === null) return null;

  if (found) lastSeen.current = { key: wanted, object: found };
  const last =
    lastSeen.current?.key === wanted ? lastSeen.current.object : null;
  const trimmed = rowsAreTrimmed(resource);
  // A row deleted before its first fetch came back still shows how it last looked.
  const shown = trimmed
    ? (whole.object ?? (found ? null : last))
    : (found ?? last);
  const name = wanted.slice(wanted.indexOf("/") + 1);
  // Metrics are for a live Node, Pod, workload or PVC. A deleted object loses the
  // tab, and a drawer showing it goes back to the overview.
  const metrics =
    shown !== null &&
    found !== undefined &&
    metricsTargetOf(resource, shown) !== null;
  if (tab === "metrics" && shown !== null && !metrics) setTab("overview");
  // The Resource map is for the kinds an object map can focus on (spec E §11).
  const tabs = [
    OVERVIEW_TAB,
    ...(metrics ? [METRICS_TAB] : []),
    ...(hasDrawerMap(resource) ? [MAP_TAB] : []),
    EVENTS_TAB,
  ];

  return (
    <aside
      ref={drawerRef}
      tabIndex={-1}
      className={styles.drawer}
      aria-label={`${resource.kind} details`}
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
        <h3 className={styles.title} data-testid="detail-title" title={name}>
          {shown?.metadata.name ?? name}
        </h3>
        <span className={styles.kind}>{resource.kind}</span>
        <div className={styles.grow} />
        {found && shown && props.actions ? (
          <>
            {props.actions(shown)}
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
      {!found && shown ? (
        <p
          className={styles.removed}
          role="status"
          data-testid="detail-removed"
        >
          This {resource.kind} was deleted. What is shown is how it last looked.
        </p>
      ) : null}
      {whole.error ? (
        <div className={styles.fetchError} data-testid="detail-fetch-error">
          <ErrorNotice
            title={
              shown
                ? `Could not load the latest ${resource.kind}`
                : `Could not load this ${resource.kind}`
            }
            message={whole.error}
            onRetry={whole.retry}
          />
        </div>
      ) : null}
      {shown ? (
        <>
          <Tabs value={tab} onChange={setTab} tabs={tabs} />
          <div className={styles.content}>
            <Body
              clusterId={clusterId}
              resource={resource}
              object={shown}
              resources={props.resources ?? []}
              columns={props.columns ?? []}
              tab={tab}
            />
          </div>
        </>
      ) : whole.error ? null : list.loading || found ? (
        <Spinner label="Loading details" />
      ) : (
        <EmptyState
          title={`${resource.kind} not found`}
          body={`There is no ${resource.kind} ${name} in the list.`}
        />
      )}
    </aside>
  );
}
