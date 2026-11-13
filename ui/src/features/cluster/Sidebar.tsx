import { ChevronDown, ChevronRight } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { NavLink, useLocation } from "react-router";
import { ErrorNotice, Spinner } from "../../design";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import {
  customResourceGroups,
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
}) {
  const { clusterId, group, plural, label } = props;
  return (
    <li>
      <NavLink
        to={resourcePath(clusterId, group, plural)}
        className={({ isActive }) =>
          isActive ? `${styles.link} ${styles.active}` : styles.link
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

/**
 * One API group under Custom Resources: a button with the group's name and kind count
 * that opens and closes its list. It starts closed, its state is kept per cluster, and
 * it opens when the page on screen becomes one of its kinds. The user can close it
 * again; it stays closed until the page changes.
 */
function CustomGroup(props: {
  clusterId: string;
  group: string;
  items: { label: string; plural: string }[];
}) {
  const { clusterId, group, items } = props;
  const [open, setOpen] = useUiState<boolean>(
    `cluster.${clusterId}.nav.custom.${group}`,
    false,
  );
  const { pathname } = useLocation();
  const active = items.some((i) => {
    const path = resourcePath(clusterId, group, i.plural);
    return pathname === path || pathname.startsWith(`${path}/`);
  });
  // Runs when `active` changes (setOpen is stable for a key), not on every render,
  // so a group the user closes on its own page stays closed.
  useEffect(() => {
    if (active) setOpen(true);
  }, [active, setOpen]);
  const panel = `nav-crd-panel-${groupSegment(group)}`;
  return (
    <li data-testid={`nav-crd-group-${group}`}>
      <button
        type="button"
        className={styles.groupToggle}
        data-active={active ? "true" : undefined}
        aria-expanded={open}
        aria-controls={panel}
        title={group}
        data-testid={`nav-crd-toggle-${group}`}
        onClick={() => setOpen(!open)}
      >
        <span aria-hidden="true" className={styles.chevron}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        <span className={styles.groupName}>{group}</span>
        <span className={styles.groupCount}>{items.length}</span>
      </button>
      <ul id={panel} className={styles.list} hidden={!open}>
        {items.map((i) => (
          <Item
            key={i.plural}
            clusterId={clusterId}
            group={group}
            plural={i.plural}
            label={i.label}
          />
        ))}
      </ul>
    </li>
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
  const crds = customResourceGroups(resources);
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
            {crds.map((g) => (
              <CustomGroup
                key={g.group}
                clusterId={clusterId}
                group={g.group}
                items={g.items}
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
