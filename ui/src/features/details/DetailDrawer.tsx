import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { EmptyState, IconButton, Spinner, Tabs } from "../../design";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import { type KubeObject, objectKey } from "../../kinds/objects";
import { kindSpec } from "../../kinds/registry";
import { useResourceList } from "../../stores/resources";
import { ConditionsSection } from "./ConditionsSection";
import styles from "./DetailDrawer.module.css";
import { EventsSection } from "./EventsSection";
import { FieldTree } from "./FieldTree";
import { MetadataSection } from "./MetadataSection";
import { ownerTarget } from "./ownerLinks";

/** One line of a kind's table, shown at the top of the drawer. */
export interface SummaryItem {
  id: string;
  label: string;
  value: React.ReactNode;
}

const TABS = [
  { value: "overview", label: "Overview" },
  { value: "events", label: "Events" },
];

function Owners(props: {
  clusterId: string;
  object: KubeObject;
  resources: ApiResourceInfo[];
}) {
  const { clusterId, object, resources } = props;
  const owners = object.metadata.ownerReferences ?? [];
  if (owners.length === 0) return null;
  return (
    <section className={styles.section}>
      <h4 className={styles.heading}>Owners</h4>
      <ul className={styles.rows}>
        {owners.map((o) => {
          const target = ownerTarget(o, object.metadata.namespace, resources);
          return (
            <li key={o.uid}>
              {target ? (
                <Link
                  className={styles.link}
                  to={`/cluster/${encodeURIComponent(clusterId)}${target}`}
                  data-testid="detail-owner-link"
                >
                  {o.kind} {o.name}
                </Link>
              ) : (
                <span>
                  {o.kind} {o.name}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Body(props: {
  clusterId: string;
  resource: ResourceRef;
  object: KubeObject;
  resources: ApiResourceInfo[];
  summary: SummaryItem[];
  tab: string;
}) {
  const { clusterId, resource, object, resources, summary, tab } = props;
  if (tab === "events") {
    return (
      <EventsSection
        clusterId={clusterId}
        kind={resource.kind}
        object={object}
      />
    );
  }
  const Detail = kindSpec(resource.group, resource.plural)?.detail;
  const { metadata: _metadata, ...rest } = object;
  return (
    <>
      {summary.length > 0 ? (
        <section className={styles.section} data-testid="detail-summary">
          <dl className={styles.facts}>
            {summary.map((s) => (
              <div key={s.id} className={styles.fact}>
                <dt className={styles.key}>{s.label}</dt>
                <dd className={styles.value}>{s.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
      <MetadataSection object={object} />
      <Owners clusterId={clusterId} object={object} resources={resources} />
      <ConditionsSection status={object.status} />
      <section className={styles.section}>
        <h4 className={styles.heading}>{Detail ? "Details" : "Fields"}</h4>
        {Detail ? (
          <Detail clusterId={clusterId} object={object} resource={resource} />
        ) : (
          <FieldTree value={rest} />
        )}
      </section>
    </>
  );
}

/**
 * The right-hand drawer of one object, kept up to date from the resource's live list.
 * It renders nothing without an `objectKey` (`<namespace>/<name>`). Escape closes it
 * and hands focus back to what had it before. `resources` lets owners link to their
 * lists, and `summary` adds the kind's table values.
 */
export function DetailDrawer(props: {
  clusterId: string;
  resource: ResourceRef;
  objectKey: string | null;
  onClose(): void;
  resources?: ApiResourceInfo[];
  summary?: SummaryItem[];
}) {
  const { clusterId, resource, objectKey: wanted, onClose } = props;
  const list = useResourceList(clusterId, resource);
  const [tab, setTab] = useState("overview");
  const drawerRef = useRef<HTMLElement>(null);
  const lastSeen = useRef<{ key: string; object: KubeObject } | null>(null);
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
    drawerRef.current
      ?.querySelector<HTMLElement>('[data-testid="detail-close"]')
      ?.focus();
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, [open]);

  if (wanted === null) return null;

  const found = list.items.find((o) => objectKey(o) === wanted);
  if (found) lastSeen.current = { key: wanted, object: found };
  const last =
    lastSeen.current?.key === wanted ? lastSeen.current.object : null;
  const shown = found ?? last;
  const name = wanted.slice(wanted.indexOf("/") + 1);

  return (
    <aside
      ref={drawerRef}
      className={styles.drawer}
      aria-label={`${resource.kind} details`}
      data-testid="detail-drawer"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <header className={styles.header}>
        <h3 className={styles.title} data-testid="detail-title" title={name}>
          {shown?.metadata.name ?? name}
        </h3>
        <span className={styles.kind}>{resource.kind}</span>
        <div className={styles.grow} />
        <IconButton
          label="Close details"
          icon={<X size={14} aria-hidden="true" />}
          onClick={onClose}
          data-testid="detail-close"
        />
      </header>
      {!found && last ? (
        <p
          className={styles.removed}
          role="status"
          data-testid="detail-removed"
        >
          This {resource.kind} was deleted. What is shown is how it last looked.
        </p>
      ) : null}
      {shown ? (
        <>
          <Tabs value={tab} onChange={setTab} tabs={TABS} />
          <div className={styles.content}>
            <Body
              clusterId={clusterId}
              resource={resource}
              object={shown}
              resources={props.resources ?? []}
              summary={props.summary ?? []}
              tab={tab}
            />
          </div>
        </>
      ) : list.loading ? (
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
