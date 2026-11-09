import { ChevronDown, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { NavLink } from "react-router";
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
              <li key={g.group} data-testid={`nav-crd-group-${g.group}`}>
                <div className={styles.group}>{g.group}</div>
                <ul className={styles.list}>
                  {g.items.map((i) => (
                    <Item
                      key={i.plural}
                      clusterId={clusterId}
                      group={g.group}
                      plural={i.plural}
                      label={i.label}
                    />
                  ))}
                </ul>
              </li>
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
