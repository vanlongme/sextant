import { ChevronDown, ChevronRight, X } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import type { Tone } from "../../design/Badge";
import { Button } from "../../design/Button";
import { IconButton } from "../../design/IconButton";
import { StatusDot } from "../../design/StatusDot";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { GraphNode } from "../../ipc/generated/GraphNode";
import type { GraphRel } from "../../ipc/generated/GraphRel";
import type { GraphStatus } from "../../ipc/generated/GraphStatus";
import { ageCell } from "../../kinds/registry";
import { ownerTarget } from "../details/ownerLinks";
import { KindIcon } from "./icons/KindIcon";
import { FOCUSABLE } from "./layout/constants";
import styles from "./MapDetails.module.css";
import {
  type Link,
  linksOf,
  listLabel,
  type MapModel,
  nodeOf,
  statusLine,
} from "./model";

/** Relation labels, outgoing then incoming (spec E §12.2). */
export const REL_OUT: Readonly<Record<GraphRel, string>> = {
  owns: "Owns",
  routes: "Routes to",
  selects: "Selects",
  mounts: "Mounts",
  env: "Reads env from",
  runsAs: "Runs as",
  claims: "Claims",
  class: "Uses class",
};

export const REL_IN: Readonly<Record<GraphRel, string>> = {
  owns: "Owned by",
  routes: "Routed from",
  selects: "Selected by",
  mounts: "Mounted by",
  env: "Env read by",
  runsAs: "Identity of",
  claims: "Claimed by",
  class: "Class of",
};

/** The status dot's tone of a node's status. */
export const STATUS_TONE: Readonly<Record<GraphStatus, Tone>> = {
  nominal: "ok",
  warning: "warn",
  critical: "danger",
  neutral: "neutral",
};

/** "Pod in shop", "GatewayClass · cluster scope" or "Outside the cluster". */
export function placeLine(node: GraphNode): string {
  if (node.kind === "LoadBalancer") return "Outside the cluster";
  return node.namespace === ""
    ? `${node.kind} · cluster scope`
    : `${node.kind} in ${node.namespace}`;
}

const relationOf = (link: Link) => (link.out ? REL_OUT : REL_IN)[link.rel];

/** One row, or several Pods of one owner on the same relation. */
type Row =
  | { type: "one"; link: Link }
  | { type: "pods"; key: string; owner: GraphNode; links: Link[] };

function ownerOf(model: MapModel, id: string): string | null {
  return model.incoming.get(id)?.find((e) => e.rel === "owns")?.from ?? null;
}

/** The node's connections, with several Pods of one owner collapsed into one row. */
export function connectionRows(model: MapModel, id: string): Row[] {
  const links = linksOf(model, id);
  const groups = new Map<string, Link[]>();
  for (const link of links) {
    const other = nodeOf(model, link.other);
    const owner = other.kind === "Pod" ? ownerOf(model, link.other) : null;
    if (owner === null || owner === id) continue;
    const key = `${link.rel}|${link.out}|${owner}`;
    groups.set(key, [...(groups.get(key) ?? []), link]);
  }
  const rows: Row[] = [];
  const done = new Set<string>();
  for (const link of links) {
    const other = nodeOf(model, link.other);
    const owner = other.kind === "Pod" ? ownerOf(model, link.other) : null;
    const key = `${link.rel}|${link.out}|${owner}`;
    const group = owner === null ? undefined : groups.get(key);
    if (owner !== null && group && group.length > 1) {
      if (done.has(key)) continue;
      done.add(key);
      rows.push({
        type: "pods",
        key,
        owner: nodeOf(model, owner),
        links: group,
      });
    } else {
      rows.push({ type: "one", link });
    }
  }
  return rows;
}

export interface MapDetailsProps {
  model: MapModel;
  /** The selected node. */
  id: string;
  clusterId: string;
  resources: ApiResourceInfo[];
  /** The object map's focus, for which "Show map" is hidden. */
  focusId?: string;
  /** A connection row was clicked: select that node and centre it. */
  onSelect(id: string): void;
  onClose(): void;
  /** "Show map for this ‹Kind›". */
  onFocus(id: string): void;
}

function ConnectionRow({
  model,
  link,
  onSelect,
}: {
  model: MapModel;
  link: Link;
  onSelect(id: string): void;
}) {
  const other = nodeOf(model, link.other);
  return (
    <li>
      <button
        type="button"
        className={styles.row}
        data-testid="map-connection"
        data-id={link.other}
        data-rel={link.rel}
        data-dir={link.out ? "out" : "in"}
        onClick={() => onSelect(link.other)}
      >
        <KindIcon kind={other.kind} size={20} />
        <span className={styles.rowText}>
          <span
            className={styles.rowRel}
          >{`${relationOf(link)} ${other.kind}`}</span>
          <span className={styles.rowName}>{other.name}</span>
        </span>
      </button>
    </li>
  );
}

/**
 * The "Connections" heading and rows of a node (spec E §12.2), for the details pane
 * and the drawer tab. Several Pods of one owner on one relation make one row that
 * expands on click.
 */
export function Connections({
  model,
  id,
  onSelect,
}: {
  model: MapModel;
  id: string;
  onSelect(id: string): void;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setOpen((was) => {
      const next = new Set(was);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <>
      <h3 className={styles.heading}>Connections</h3>
      <ul className={styles.rows}>
        {connectionRows(model, id).map((row) => {
          if (row.type === "one") {
            return (
              <ConnectionRow
                key={`${row.link.rel}|${row.link.out}|${row.link.other}`}
                model={model}
                link={row.link}
                onSelect={onSelect}
              />
            );
          }
          const first = row.links[0];
          const expanded = open.has(row.key);
          return (
            <li key={row.key}>
              <button
                type="button"
                className={styles.row}
                data-testid="map-connection-group"
                data-rel={first.rel}
                data-dir={first.out ? "out" : "in"}
                aria-expanded={expanded}
                onClick={() => toggle(row.key)}
              >
                {expanded ? (
                  <ChevronDown size={16} />
                ) : (
                  <ChevronRight size={16} />
                )}
                <span className={styles.rowText}>
                  <span className={styles.rowRel}>
                    {`${relationOf(first)} ${row.links.length} Pods of ${row.owner.name}`}
                  </span>
                </span>
              </button>
              {expanded ? (
                <ul className={styles.rows}>
                  {row.links.map((link) => (
                    <ConnectionRow
                      key={link.other}
                      model={model}
                      link={link}
                      onSelect={onSelect}
                    />
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** The details pane of a selected node (spec E §12). */
export function MapDetails({
  model,
  id,
  clusterId,
  resources,
  focusId,
  onSelect,
  onClose,
  onFocus,
}: MapDetailsProps) {
  const navigate = useNavigate();
  const node = nodeOf(model, id);
  const target =
    node.plural === ""
      ? null
      : ownerTarget(
          {
            kind: node.kind,
            name: node.name,
            apiVersion: node.group === "" ? "v1" : `${node.group}/v1`,
          },
          node.namespace,
          resources,
        );
  const status = statusLine(node);

  return (
    <aside
      className={styles.pane}
      data-testid="map-details"
      aria-label={`${node.kind} ${node.name}`}
    >
      <header className={styles.head}>
        <KindIcon kind={node.kind} size={40} />
        <div className={styles.headText}>
          <span className={styles.place}>{placeLine(node)}</span>
          <h2 className={styles.name}>{node.name}</h2>
          <span className={styles.status}>
            <StatusDot tone={STATUS_TONE[node.status]} label={status} />
            {status}
          </span>
        </div>
        <IconButton
          label="Close details"
          icon={<X size={16} />}
          data-testid="map-details-close"
          onClick={onClose}
        />
      </header>
      <div className={styles.actions}>
        {FOCUSABLE.has(node.kind) && id !== focusId ? (
          <Button
            size="sm"
            data-testid="map-details-focus"
            onClick={() => onFocus(id)}
          >
            {`Show map for this ${node.kind}`}
          </Button>
        ) : null}
        {target !== null ? (
          <Button
            size="sm"
            variant="ghost"
            data-testid="map-details-open"
            onClick={() => navigate(`/cluster/${clusterId}${target}`)}
          >
            {`Open in ${listLabel(node.plural, node.kind)}`}
          </Button>
        ) : null}
      </div>
      <dl className={styles.facts}>
        {node.facts.map(([label, value]) => (
          <div
            key={label}
            className={styles.fact}
            data-testid="map-fact"
            data-label={label}
          >
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
        {node.created !== null ? (
          <div className={styles.fact} data-testid="map-fact" data-label="Age">
            <dt>Age</dt>
            <dd>{ageCell(node.created)}</dd>
          </div>
        ) : null}
      </dl>
      <Connections model={model} id={id} onSelect={onSelect} />
    </aside>
  );
}
