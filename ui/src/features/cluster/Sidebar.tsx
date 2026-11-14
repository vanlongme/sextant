import { ChevronDown, ChevronRight } from "lucide-react";
import { type ReactNode, useEffect, useMemo } from "react";
import { NavLink, useLocation } from "react-router";
import { ErrorNotice, Spinner } from "../../design";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import {
  type CrdDomainRow,
  type CrdKindItem,
  crdTree,
} from "../../kinds/crdTree";
import {
  groupSegment,
  type NavSection,
  navItemKey,
  resourcePath,
  visibleSections,
} from "../../kinds/nav";
import { useUiState } from "../../stores/uiState";
import styles from "./Sidebar.module.css";

function Item(props: {
  clusterId: string;
  group: string;
  plural: string;
  label: string;
  /** Tree depth of a Custom Resources kind: 1 under a level-1 row, 2 under a level-2 row. */
  indent?: 1 | 2;
}) {
  const { clusterId, group, plural, label, indent } = props;
  const base = indent
    ? `${styles.link} ${styles[`indent${indent}`]}`
    : styles.link;
  return (
    <li>
      <NavLink
        to={resourcePath(clusterId, group, plural)}
        className={({ isActive }) =>
          isActive ? `${base} ${styles.active}` : base
        }
        data-testid={`nav-item-${groupSegment(group)}-${plural}`}
        title={label}
      >
        {label}
      </NavLink>
    </li>
  );
}

function RouteItem(props: { clusterId: string; path: string; label: string }) {
  const { clusterId, path, label } = props;
  return (
    <li>
      <NavLink
        to={`/cluster/${encodeURIComponent(clusterId)}/${path}`}
        className={({ isActive }) =>
          isActive ? `${styles.link} ${styles.active}` : styles.link
        }
        data-testid={`nav-${path}`}
        title={label}
      >
        {label}
      </NavLink>
    </li>
  );
}

/** The saved open state of a tree row (spec H §4.2). */
function rowKey(clusterId: string, level: "domain" | "group", name: string) {
  return `cluster.${clusterId}.nav.custom.${level}.${name}`;
}

/** The API group whose kind's list is on screen, or null. */
function activeCrdGroup(
  rows: CrdDomainRow[],
  clusterId: string,
  pathname: string,
): string | null {
  for (const row of rows) {
    for (const item of [...row.items, ...row.groups.flatMap((g) => g.items)]) {
      const path = resourcePath(clusterId, item.group, item.plural);
      if (pathname === path || pathname.startsWith(`${path}/`)) {
        return item.group;
      }
    }
  }
  return null;
}

/**
 * A row's open state, kept per cluster. It opens when the page on screen comes under
 * it. The effect runs when `active` changes (setOpen is stable for a key), not on every
 * render, so a row the user closes on its own page stays closed.
 */
function useRowOpen(
  key: string,
  active: boolean,
): [boolean, (v: boolean) => void] {
  const [open, setOpen] = useUiState<boolean>(key, false);
  useEffect(() => {
    if (active) setOpen(true);
  }, [active, setOpen]);
  return [open, setOpen];
}

function RowToggle(props: {
  open: boolean;
  active: boolean;
  panel: string;
  title: string;
  label: string;
  count: number;
  depth: 1 | 2;
  testId: string;
  onToggle(): void;
}) {
  return (
    <button
      type="button"
      className={
        props.depth === 2
          ? `${styles.groupToggle} ${styles.depth2}`
          : styles.groupToggle
      }
      data-active={props.active ? "true" : undefined}
      aria-expanded={props.open}
      aria-controls={props.panel}
      title={props.title}
      data-testid={props.testId}
      onClick={props.onToggle}
    >
      <span aria-hidden="true" className={styles.chevron}>
        {props.open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </span>
      <span className={styles.groupName}>{props.label}</span>
      <span className={styles.groupCount}>{props.count}</span>
    </button>
  );
}

function KindLinks(props: {
  clusterId: string;
  items: CrdKindItem[];
  indent: 1 | 2;
}) {
  return (
    <>
      {props.items.map((i) => (
        <Item
          key={`${i.group}/${i.plural}`}
          clusterId={props.clusterId}
          group={i.group}
          plural={i.plural}
          label={i.label}
          indent={props.indent}
        />
      ))}
    </>
  );
}

/** A "group" row (level 1) or a level-2 row: an API group that opens to its kinds. */
function GroupRow(props: {
  clusterId: string;
  group: string;
  label: string;
  title: string;
  items: CrdKindItem[];
  storageKey: string;
  depth: 1 | 2;
  activeGroup: string | null;
}) {
  const active = props.activeGroup === props.group;
  const [open, setOpen] = useRowOpen(props.storageKey, active);
  const panel = `nav-crd-panel-${props.group}`;
  return (
    <li data-testid={`nav-crd-group-${props.group}`}>
      <RowToggle
        open={open}
        active={active}
        panel={panel}
        title={props.title}
        label={props.label}
        count={props.items.length}
        depth={props.depth}
        testId={`nav-crd-toggle-${props.group}`}
        onToggle={() => setOpen(!open)}
      />
      {/* A closed row keeps its panel for aria-controls and mounts nothing in it. */}
      <ul id={panel} data-testid={panel} className={styles.list} hidden={!open}>
        {open ? (
          <KindLinks
            clusterId={props.clusterId}
            items={props.items}
            indent={props.depth}
          />
        ) : null}
      </ul>
    </li>
  );
}

/** A domain with several API groups: its own kinds first, then its level-2 rows. */
function DomainRow(props: {
  clusterId: string;
  row: CrdDomainRow;
  activeGroup: string | null;
}) {
  const { clusterId, row, activeGroup } = props;
  const active =
    activeGroup !== null &&
    (row.items.some((i) => i.group === activeGroup) ||
      row.groups.some((g) => g.group === activeGroup));
  const [open, setOpen] = useRowOpen(
    rowKey(clusterId, "domain", row.domain),
    active,
  );
  const panel = `nav-crd-domain-panel-${row.domain}`;
  return (
    <li data-testid={`nav-crd-domain-${row.domain}`}>
      <RowToggle
        open={open}
        active={active}
        panel={panel}
        title={row.title}
        label={row.label}
        count={row.count}
        depth={1}
        testId={`nav-crd-domain-toggle-${row.domain}`}
        onToggle={() => setOpen(!open)}
      />
      <ul id={panel} data-testid={panel} className={styles.list} hidden={!open}>
        {open ? (
          <>
            <KindLinks clusterId={clusterId} items={row.items} indent={1} />
            {row.groups.map((g) => (
              <GroupRow
                key={g.group}
                clusterId={clusterId}
                group={g.group}
                label={g.label}
                title={g.group}
                items={g.items}
                storageKey={rowKey(clusterId, "group", g.group)}
                depth={2}
                activeGroup={activeGroup}
              />
            ))}
          </>
        ) : null}
      </ul>
    </li>
  );
}

/** One level-1 row of the tree. A "group" row uses its domain's key (spec H7). */
function CrdRow(props: {
  clusterId: string;
  row: CrdDomainRow;
  activeGroup: string | null;
}) {
  const { clusterId, row, activeGroup } = props;
  if (row.type === "domain") {
    return (
      <DomainRow clusterId={clusterId} row={row} activeGroup={activeGroup} />
    );
  }
  return (
    <GroupRow
      clusterId={clusterId}
      group={row.label}
      label={row.label}
      title={row.title}
      items={row.items}
      storageKey={rowKey(clusterId, "domain", row.domain)}
      depth={1}
      activeGroup={activeGroup}
    />
  );
}

function Section(props: {
  clusterId: string;
  id: string;
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useUiState<boolean>(
    `cluster.${props.clusterId}.nav.${props.id}`,
    true,
  );
  const panel = `nav-panel-${props.id}`;
  return (
    <section data-testid={`nav-section-${props.id}`} className={styles.section}>
      <h3 className={styles.heading}>
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={open}
          aria-controls={panel}
          onClick={() => setOpen(!open)}
        >
          <span aria-hidden="true" className={styles.chevron}>
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
          {props.label}
        </button>
      </h3>
      <ul id={panel} className={styles.list} hidden={!open}>
        {props.children}
      </ul>
    </section>
  );
}

function SectionItems(props: { clusterId: string; section: NavSection }) {
  const { clusterId, section } = props;
  const overview = section.overview;
  const items = section.items.map((i) =>
    i.type === "route" ? (
      <RouteItem
        key={navItemKey(i)}
        clusterId={clusterId}
        path={i.path}
        label={i.label}
      />
    ) : (
      <Item
        key={navItemKey(i)}
        clusterId={clusterId}
        group={i.group}
        plural={i.plural}
        label={i.label}
      />
    ),
  );
  if (overview === undefined) return items;
  return [
    <li key="overview">
      <NavLink
        end
        to={`/cluster/${encodeURIComponent(clusterId)}/${overview}`}
        className={({ isActive }) =>
          isActive ? `${styles.link} ${styles.active}` : styles.link
        }
        data-testid={`nav-overview-${overview}`}
      >
        Overview
      </NavLink>
    </li>,
    ...items,
  ];
}

/** The cluster navigation: Overview, then the resource sections the user can see. */
export function Sidebar(props: {
  clusterId: string;
  resources: ApiResourceInfo[];
  loading: boolean;
  error: string | null;
  onRetry(): void;
}) {
  const { clusterId, resources } = props;
  const sections = visibleSections(resources);
  const crds = useMemo(() => crdTree(resources), [resources]);
  const { pathname } = useLocation();
  const activeGroup = useMemo(
    () => activeCrdGroup(crds, clusterId, pathname),
    [crds, clusterId, pathname],
  );
  const custom = sections.find((s) => s.id === "custom");

  let body: ReactNode;
  if (props.loading && resources.length === 0) {
    body = (
      <div className={styles.state}>
        <Spinner label="Loading resources" />
      </div>
    );
  } else {
    body = (
      <>
        {sections
          .filter((s) => s.id !== "custom")
          .map((s) => (
            <Section key={s.id} clusterId={clusterId} id={s.id} label={s.label}>
              <SectionItems clusterId={clusterId} section={s} />
            </Section>
          ))}
        {custom || crds.length > 0 ? (
          <Section clusterId={clusterId} id="custom" label="Custom Resources">
            {custom ? (
              <SectionItems clusterId={clusterId} section={custom} />
            ) : null}
            {crds.map((row) => (
              <CrdRow
                key={row.domain}
                clusterId={clusterId}
                row={row}
                activeGroup={activeGroup}
              />
            ))}
          </Section>
        ) : null}
      </>
    );
  }

  return (
    <nav
      className={styles.sidebar}
      aria-label="Cluster navigation"
      data-testid="cluster-sidebar"
    >
      <NavLink
        end
        to={`/cluster/${encodeURIComponent(clusterId)}`}
        className={({ isActive }) =>
          isActive ? `${styles.link} ${styles.active}` : styles.link
        }
        data-testid="nav-overview"
      >
        Overview
      </NavLink>
      <NavLink
        to={`/cluster/${encodeURIComponent(clusterId)}/map`}
        className={({ isActive }) =>
          isActive ? `${styles.link} ${styles.active}` : styles.link
        }
        data-testid="nav-map"
        title="Resource map"
      >
        Resource map
      </NavLink>
      {/* A failed refresh keeps the last resources, so the error sits above them. */}
      {props.error !== null ? (
        <div className={styles.state}>
          <ErrorNotice
            title="Could not load resources"
            message={props.error}
            onRetry={props.onRetry}
          />
        </div>
      ) : null}
      {body}
    </nav>
  );
}
