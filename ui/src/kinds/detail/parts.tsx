import {
  ChevronDown,
  ChevronRight,
  FileText,
  type LucideIcon,
} from "lucide-react";
import {
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useId,
  useState,
} from "react";
import { Link } from "react-router";
import { ownerTarget } from "../../features/details/ownerLinks";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import { useUiState } from "../../stores/uiState";
import { DrawerLinkContext, objectTarget, targetKey } from "./links";
import styles from "./parts.module.css";

/** Label and value pairs; an item whose value is empty is left out. */
export function Facts(props: {
  items: [string, ReactNode | undefined | null][];
}) {
  const shown = props.items.filter(
    ([, value]) => value !== undefined && value !== null && value !== "",
  );
  if (shown.length === 0) return null;
  return (
    <dl className={styles.facts}>
      {shown.map(([label, value]) => (
        <div key={label} className={styles.fact}>
          <dt className={styles.key}>{label}</dt>
          <dd className={styles.value}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The kind of the object a drawer shows; `Part` keys its saved state with it. */
export const DrawerKindContext = createContext<{
  group: string;
  plural: string;
} | null>(null);

/** How deep in `Part`s a component is: a nested `Part` is a sub-heading (spec H27). */
const PartDepth = createContext(0);

/** The title in lower case, each run of other characters than a-z0-9 made "-". */
export function sectionSlug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

/** The title without a trailing " (<number>)", so "Sources (2)" and "Sources (3)" match. */
export function titleKey(title: string): string {
  return title.replace(/ \(\d+\)$/, "");
}

interface PartProps {
  title: string;
  testId?: string;
  /** A lucide icon, 14 px, before the title. Defaults to FileText. */
  icon?: LucideIcon;
  /** A count pill after the title. */
  count?: number;
  children: ReactNode;
}

function Card(props: PartProps & { collapsed: boolean; onToggle(): void }) {
  const id = useId();
  const Icon = props.icon ?? FileText;
  const head = `${id}head`;
  const body = `${id}body`;
  return (
    <section
      className={styles.card}
      data-testid={props.testId}
      aria-labelledby={head}
    >
      <h4 className={styles.cardHead}>
        <button
          type="button"
          id={head}
          className={styles.cardToggle}
          aria-expanded={!props.collapsed}
          aria-controls={body}
          data-testid={`detail-section-toggle-${sectionSlug(props.title)}`}
          onClick={props.onToggle}
        >
          <span aria-hidden="true" className={styles.chevron}>
            {props.collapsed ? (
              <ChevronRight size={12} />
            ) : (
              <ChevronDown size={12} />
            )}
          </span>
          <Icon size={14} aria-hidden="true" className={styles.cardIcon} />
          <span className={styles.cardTitle}>{props.title}</span>
          {props.count !== undefined ? (
            <span className={styles.count}>{props.count}</span>
          ) : null}
        </button>
      </h4>
      {/* A closed body stays mounted, so unsaved edits in it survive (spec H25). */}
      <div id={body} className={styles.cardBody} hidden={props.collapsed}>
        <PartDepth.Provider value={1}>{props.children}</PartDepth.Provider>
      </div>
    </section>
  );
}

function SavedCard(
  props: PartProps & { kind: { group: string; plural: string } },
) {
  const { kind, ...rest } = props;
  const [collapsed, setCollapsed] = useUiState<boolean>(
    `drawer.section.${kind.group}/${kind.plural}.${titleKey(props.title)}`,
    false,
  );
  return (
    <Card
      {...rest}
      collapsed={collapsed}
      onToggle={() => setCollapsed(!collapsed)}
    />
  );
}

function LocalCard(props: PartProps) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <Card
      {...props}
      collapsed={collapsed}
      onToggle={() => setCollapsed(!collapsed)}
    />
  );
}

function SubPart(props: PartProps) {
  return (
    <div className={styles.sub} data-testid={props.testId}>
      <h5 className={styles.subHeading}>{props.title}</h5>
      {props.children}
    </div>
  );
}

/**
 * A section of a drawer's Overview: a card that collapses, its state saved per kind and
 * title inside a drawer (spec H24–H27). Inside another `Part` it is a plain sub-heading.
 */
export function Part(props: PartProps): ReactElement {
  const depth = useContext(PartDepth);
  const kind = useContext(DrawerKindContext);
  if (depth > 0) return <SubPart {...props} />;
  if (kind) return <SavedCard {...props} kind={kind} />;
  return <LocalCard {...props} />;
}

/** A fact that opens to a body; it starts closed and saves nothing (spec H32). */
export function ExpandRow(props: {
  label: string;
  count: number;
  summary: string;
  testId?: string;
  children: ReactNode;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const body = useId();
  return (
    <div className={styles.expand} data-testid={props.testId}>
      <button
        type="button"
        className={styles.expandToggle}
        aria-expanded={open}
        aria-controls={body}
        data-testid={`detail-expand-${sectionSlug(props.label)}`}
        onClick={() => setOpen(!open)}
      >
        <span className={styles.expandKey}>
          <span aria-hidden="true" className={styles.chevron}>
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
          {props.label}
        </span>
        <span className={styles.expandCount}>{props.count}</span>
        <span className={styles.expandSummary} title={props.summary}>
          {props.summary}
        </span>
      </button>
      <div id={body} className={styles.expandBody} hidden={!open}>
        {props.children}
      </div>
    </div>
  );
}

/** Facts with a 104 px key. */
export function FactList(props: { children: ReactNode }): ReactElement {
  return <dl className={styles.factList}>{props.children}</dl>;
}

export function FactRow(props: {
  label: string;
  testId?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div className={styles.factRow} data-testid={props.testId}>
      <dt className={styles.factKey}>{props.label}</dt>
      <dd className={styles.factValue}>{props.children}</dd>
    </div>
  );
}

export interface StatItem {
  id: string;
  label: string;
  value: ReactNode;
  title?: string;
}

/** The Summary's stat grid (spec H29). */
export function StatGrid(props: { stats: readonly StatItem[] }): ReactElement {
  return (
    <dl className={styles.stats}>
      {props.stats.map((s) => (
        <div
          key={s.id}
          className={styles.stat}
          data-testid={`detail-stat-${s.id}`}
          title={s.title}
        >
          <dt className={styles.statKey}>{s.label}</dt>
          <dd className={styles.statValue}>{s.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Items split by a hairline, as Volumes and Containers are. */
export function ItemList(props: { children: ReactNode }): ReactElement {
  return <ul className={styles.items}>{props.children}</ul>;
}

export function Item(props: {
  testId?: string;
  head: ReactNode;
  children?: ReactNode;
}): ReactElement {
  return (
    <li className={styles.item} data-testid={props.testId}>
      <div className={styles.itemHead}>{props.head}</div>
      {props.children}
    </li>
  );
}

/** A 72 px key and its lines, inside an item. */
export function SubRow(props: {
  label: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div className={styles.subRow}>
      <span className={styles.subKey}>{props.label}</span>
      <div className={styles.subLines}>{props.children}</div>
    </div>
  );
}

export function Chips(props: { values: string[] }) {
  return (
    <ul className={styles.chips}>
      {props.values.map((value, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: values may repeat
        <li key={`${index}:${value}`} className={styles.chip}>
          {value}
        </li>
      ))}
    </ul>
  );
}

export function SimpleTable(props: {
  testId?: string;
  headers: string[];
  rows: ReactNode[][];
  empty: string;
}) {
  if (props.rows.length === 0) {
    return <p className={styles.muted}>{props.empty}</p>;
  }
  return (
    <table className={styles.table} data-testid={props.testId}>
      <thead>
        <tr>
          {props.headers.map((header) => (
            <th key={header}>{header}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {props.rows.map((row, r) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity
          <tr key={r}>
            {row.map((cell, c) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: cells have no identity
              <td key={c}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * `<kind> <name>`, or `label`. Inside a drawer it is a button that opens the object in
 * that drawer; elsewhere a link to the object's list. Plain text when the kind is not
 * served.
 */
export function ObjectLink(props: {
  clusterId: string;
  resources: ApiResourceInfo[];
  kind: string;
  name: string;
  namespace?: string;
  apiVersion?: string;
  label?: string;
  testId?: string;
}) {
  const drawer = useContext(DrawerLinkContext);
  const ref = {
    kind: props.kind,
    name: props.name,
    apiVersion: props.apiVersion,
  };
  const label = props.label ?? `${props.kind} ${props.name}`;
  if (drawer) {
    const target = objectTarget(ref, props.namespace, props.resources);
    if (!target) return <>{label}</>;
    return (
      <button
        type="button"
        className={styles.link}
        data-testid={props.testId ?? "detail-link"}
        data-target={targetKey(target)}
        title={`Open ${props.kind} ${props.name}`}
        onClick={() => drawer.open(target)}
      >
        {label}
      </button>
    );
  }
  const route = ownerTarget(ref, props.namespace, props.resources);
  if (!route) return <>{label}</>;
  return (
    <Link
      className={styles.link}
      to={`/cluster/${encodeURIComponent(props.clusterId)}${route}`}
      data-testid={props.testId}
    >
      {label}
    </Link>
  );
}
