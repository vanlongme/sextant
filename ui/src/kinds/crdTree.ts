import type { ApiResourceInfo } from "../ipc/generated/ApiResourceInfo";
import { customResourceGroups } from "./nav";

/** A kind under Custom Resources. */
export interface CrdKindItem {
  label: string;
  group: string;
  plural: string;
}

/** A level-2 row: an API group of a domain with several groups. */
export interface CrdGroupRow {
  group: string;
  /** The group without ".<domain>". */
  label: string;
  items: CrdKindItem[];
}

/** A level-1 row of the Custom Resources tree (spec H §4.1). */
export interface CrdDomainRow {
  domain: string;
  /** "group" when the domain holds exactly one API group: the row stands for that group. */
  type: "domain" | "group";
  /** The domain, or for a "group" row its full group name. */
  label: string;
  /** "<domain> · <n> API groups", or the full group name for a "group" row. */
  title: string;
  /** For "domain": the kinds of the group equal to the domain. For "group": the group's kinds. */
  items: CrdKindItem[];
  /** For "domain": the other groups. For "group": empty. */
  groups: CrdGroupRow[];
  /** Every kind under the row, at every level. */
  count: number;
}

const DIGITS = /^\d+$/;

/**
 * The group's last two DNS labels. A group of one or two labels, or one whose last two
 * labels are all digits (an IP-like name), is its own domain. No public-suffix list.
 */
export function baseDomain(group: string): string {
  const labels = group.split(".");
  if (labels.length <= 2) return group;
  const last = labels.slice(-2);
  if (last.every((label) => DIGITS.test(label))) return group;
  return last.join(".");
}

const byLabel = (a: { label: string }, b: { label: string }) =>
  a.label.localeCompare(b.label);

const byKind = (a: CrdKindItem, b: CrdKindItem) =>
  a.label.localeCompare(b.label) || a.plural.localeCompare(b.plural);

/**
 * The Custom Resources tree: base domain, then API group, then kind. It keeps
 * `customResourceGroups`' rules (no built-in groups, no unlistable or nav-listed kinds).
 */
export function crdTree(resources: ApiResourceInfo[]): CrdDomainRow[] {
  const domains = new Map<string, { group: string; items: CrdKindItem[] }[]>();
  for (const g of customResourceGroups(resources)) {
    const domain = baseDomain(g.group);
    const items = g.items
      .map((i) => ({ label: i.label, group: g.group, plural: i.plural }))
      .sort(byKind);
    const list = domains.get(domain) ?? [];
    list.push({ group: g.group, items });
    domains.set(domain, list);
  }
  const rows: CrdDomainRow[] = [];
  for (const [domain, groups] of domains) {
    if (groups.length === 1) {
      const [only] = groups;
      rows.push({
        domain,
        type: "group",
        label: only.group,
        title: only.group,
        items: only.items,
        groups: [],
        count: only.items.length,
      });
      continue;
    }
    const own = groups.find((g) => g.group === domain);
    const others = groups
      .filter((g) => g !== own)
      .map((g) => ({
        group: g.group,
        label: g.group.slice(0, -(domain.length + 1)),
        items: g.items,
      }))
      .sort(byLabel);
    rows.push({
      domain,
      type: "domain",
      label: domain,
      title: `${domain} · ${groups.length} API groups`,
      items: own?.items ?? [],
      groups: others,
      count: groups.reduce((n, g) => n + g.items.length, 0),
    });
  }
  return rows.sort(byLabel);
}
