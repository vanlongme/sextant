import { FunnelX } from "lucide-react";
import { type ReactElement, useState } from "react";
import { Button } from "../../design/Button";
import { FilterPopover } from "../../design/FilterPopover";
import type { GraphNamespaceCount } from "../../ipc/generated/GraphNamespaceCount";
import {
  filtersActive,
  type GroupState,
  groupState,
  hideListed,
  type KindGroup,
  kindTrigger,
  matchesKind,
  namespaceTrigger,
  showListed,
  tally,
  toggleGroup,
} from "./filters";
import { KindIcon } from "./icons/KindIcon";
import styles from "./MapFilters.module.css";

export interface MapFiltersProps {
  /** The snapshot's counts; cluster scope is left out of the list. */
  counts: readonly GraphNamespaceCount[];
  /** `map.hidden.<clusterId>`. */
  hiddenNamespaces: readonly string[];
  onHiddenNamespacesChange(hidden: string[]): void;
  /** `kindGroups` of the namespace view. */
  groups: readonly KindGroup[];
  /** `map.hiddenKinds.<clusterId>`. */
  hiddenKinds: readonly string[];
  onHiddenKindsChange(hidden: string[]): void;
  /** Null while no model is drawn yet: the row keeps its dropdowns. */
  summary: string | null;
  summaryTitle: string;
}

const GROUP_TEXT: Readonly<Record<GroupState, string>> = {
  all: "all kinds shown",
  some: "some kinds shown",
  none: "all kinds hidden",
};

const en = (n: number) => n.toLocaleString("en-US");

/** The list with `item` added or removed, sorted and unique. */
function toggled(list: readonly string[], item: string): string[] {
  return list.includes(item)
    ? list.filter((x) => x !== item)
    : [...new Set([...list, item])].sort();
}

/**
 * The map's filters row (spec H54): Namespaces, Kinds, Clear filters and the summary.
 * At most one of the two popovers is open.
 */
export function MapFilters(props: MapFiltersProps): ReactElement {
  const [openMenu, setOpenMenu] = useState<"ns" | "kind" | null>(null);
  const [nsQuery, setNsQuery] = useState("");
  const [kindQuery, setKindQuery] = useState("");
  const menu = (id: "ns" | "kind") => ({
    open: openMenu === id,
    onOpenChange: (open: boolean) =>
      setOpenMenu((current) => (open ? id : current === id ? null : current)),
  });

  const hiddenNs = new Set(props.hiddenNamespaces);
  const namespaces = props.counts
    .filter((c) => c.namespace !== "")
    .sort((a, b) => a.namespace.localeCompare(b.namespace));
  const names = namespaces.map((c) => c.namespace);
  const nsNeedle = nsQuery.trim().toLowerCase();
  const nsListed = namespaces.filter((c) =>
    c.namespace.toLowerCase().includes(nsNeedle),
  );
  const nsListedNames = nsListed.map((c) => c.namespace);
  const nsShown = names.filter((n) => !hiddenNs.has(n)).length;

  const hiddenKinds = new Set(props.hiddenKinds);
  const kindRows = props.groups.flatMap((g) => g.kinds);
  const kindShown = kindRows.filter((r) => !hiddenKinds.has(r.kind)).length;
  const kindListed = props.groups
    .map((group) => ({
      group,
      rows: group.kinds.filter((r) => matchesKind(r, group.label, kindQuery)),
    }))
    .filter((g) => g.rows.length > 0);
  const kindListedNames = kindListed.flatMap((g) => g.rows.map((r) => r.kind));

  const nsTrigger = namespaceTrigger(names, hiddenNs);
  const kTrigger = kindTrigger(props.groups, hiddenKinds);
  const active = filtersActive(names, hiddenNs, props.groups, hiddenKinds);

  return (
    <fieldset
      aria-label="Map filters"
      data-testid="map-filters"
      className={styles.row}
    >
      <FilterPopover
        {...menu("ns")}
        label={nsTrigger.label}
        title={nsTrigger.title}
        name="Namespaces"
        width={272}
        triggerTestId="map-ns-filter"
        testId="map-ns-popover"
        search={{
          label: "Filter namespaces",
          value: nsQuery,
          onChange: setNsQuery,
          testId: "map-ns-search",
        }}
        tools={
          <>
            <Button
              size="sm"
              variant="ghost"
              data-testid="map-ns-select-all"
              disabled={!nsListedNames.some((n) => hiddenNs.has(n))}
              onClick={() =>
                props.onHiddenNamespacesChange(
                  showListed(props.hiddenNamespaces, nsListedNames),
                )
              }
            >
              Select all
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-testid="map-ns-clear"
              disabled={nsListedNames.every((n) => hiddenNs.has(n))}
              onClick={() =>
                props.onHiddenNamespacesChange(
                  hideListed(props.hiddenNamespaces, nsListedNames),
                )
              }
            >
              Clear
            </Button>
            <span className={styles.tally}>{tally(nsShown, names.length)}</span>
          </>
        }
        foot="Only checked namespaces are loaded, plus what routes traffic into them."
      >
        {nsListed.length === 0 ? (
          <p className={styles.empty}>No namespace matches.</p>
        ) : (
          <ul className={styles.options}>
            {nsListed.map((c) => {
              const off = hiddenNs.has(c.namespace);
              return (
                <li key={c.namespace}>
                  <label className={styles.option}>
                    <input
                      type="checkbox"
                      checked={!off}
                      onChange={() =>
                        props.onHiddenNamespacesChange(
                          toggled(props.hiddenNamespaces, c.namespace),
                        )
                      }
                      data-testid={`map-ns-option-${c.namespace}`}
                    />
                    <span
                      className={
                        off ? `${styles.name} ${styles.off}` : styles.name
                      }
                      title={c.namespace}
                    >
                      {c.namespace}
                    </span>
                    <span className={styles.count}>{en(c.nodes)}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </FilterPopover>
      <FilterPopover
        {...menu("kind")}
        label={kTrigger.label}
        title={kTrigger.title}
        name="Kinds"
        width={296}
        triggerTestId="map-kind-filter"
        testId="map-kind-popover"
        search={{
          label: "Filter kinds",
          value: kindQuery,
          onChange: setKindQuery,
          testId: "map-kind-search",
        }}
        tools={
          <>
            <Button
              size="sm"
              variant="ghost"
              data-testid="map-kind-select-all"
              disabled={!kindListedNames.some((k) => hiddenKinds.has(k))}
              onClick={() =>
                props.onHiddenKindsChange(
                  showListed(props.hiddenKinds, kindListedNames),
                )
              }
            >
              Select all
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-testid="map-kind-clear"
              disabled={kindListedNames.every((k) => hiddenKinds.has(k))}
              onClick={() =>
                props.onHiddenKindsChange(
                  hideListed(props.hiddenKinds, kindListedNames),
                )
              }
            >
              Clear
            </Button>
            <span className={styles.tally}>
              {tally(kindShown, kindRows.length)}
            </span>
          </>
        }
        foot="Links through hidden kinds show dashed."
      >
        {kindListed.length === 0 ? (
          <p className={styles.empty}>No kind matches.</p>
        ) : (
          kindListed.map(({ group, rows }) => {
            const state = groupState(rows, hiddenKinds);
            return (
              <div key={group.id} className={styles.group}>
                <label className={styles.groupRow}>
                  <input
                    type="checkbox"
                    ref={(el) => {
                      if (el) el.indeterminate = state === "some";
                    }}
                    checked={state === "all"}
                    aria-label={`${group.label}, ${GROUP_TEXT[state]}`}
                    data-testid={`map-kind-group-${group.id}`}
                    onChange={() =>
                      props.onHiddenKindsChange(
                        toggleGroup(rows, props.hiddenKinds),
                      )
                    }
                  />
                  <span className={styles.groupLabel}>{group.label}</span>
                  <span className={styles.count}>{en(group.nodes)}</span>
                </label>
                <ul className={styles.options}>
                  {rows.map((r) => {
                    const off = hiddenKinds.has(r.kind);
                    return (
                      <li key={r.kind}>
                        <label className={`${styles.option} ${styles.kind}`}>
                          <input
                            type="checkbox"
                            checked={!off}
                            onChange={() =>
                              props.onHiddenKindsChange(
                                toggled(props.hiddenKinds, r.kind),
                              )
                            }
                            data-testid={`map-kind-option-${r.kind}`}
                          />
                          <span
                            className={
                              off
                                ? `${styles.icon} ${styles.iconOff}`
                                : styles.icon
                            }
                            aria-hidden="true"
                          >
                            <KindIcon kind={r.kind} size={18} />
                          </span>
                          <span
                            className={
                              off ? `${styles.name} ${styles.off}` : styles.name
                            }
                            title={r.label}
                          >
                            {r.label}
                          </span>
                          <span className={styles.count}>{en(r.nodes)}</span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })
        )}
      </FilterPopover>
      {active ? (
        <Button
          size="sm"
          variant="ghost"
          data-testid="map-clear-filters"
          onClick={() => {
            props.onHiddenNamespacesChange([]);
            props.onHiddenKindsChange([]);
          }}
        >
          <FunnelX size={14} aria-hidden="true" />
          Clear filters
        </Button>
      ) : null}
      <div className={styles.grow} />
      {props.summary !== null ? (
        <span
          className={styles.summary}
          data-testid="map-summary"
          title={props.summaryTitle}
        >
          {props.summary}
        </span>
      ) : null}
    </fieldset>
  );
}
