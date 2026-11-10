import { type LucideIcon, Server } from "lucide-react";
import { clusterStatus } from "../../app/clusterStatus";
import { COMMANDS, type CommandContext } from "../../app/commands";
import { shortKeys } from "../../app/shortcuts";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { ClusterEntry } from "../../ipc/generated/ClusterEntry";
import type { ObjectName } from "../../ipc/generated/ObjectName";
import {
  customResourceGroups,
  groupSegment,
  resourcePath,
  visibleSections,
} from "../../kinds/nav";
import { connectCluster } from "../../stores/clusters";
import { isBlank, matchEntry } from "./fuzzy";
import {
  CUSTOM_ICON,
  FALLBACK_ICON,
  KIND_ICONS,
  OVERVIEW_ICON,
  ROUTE_ICONS,
  SECTION_ICONS,
} from "./icons";

export type SectionId = "commands" | "clusters" | "pages" | "objects";

/** One thing the palette can run. */
export interface PaletteEntry {
  /** Unique within its section; the React key. */
  key: string;
  testId: string;
  label: string;
  hint: string;
  icon: LucideIcon;
  run(ctx: CommandContext): void;
}

export interface PaletteRow extends PaletteEntry {
  score: number;
  ranges: [number, number][];
}

export interface PaletteSection {
  id: SectionId;
  heading: string;
  rows: PaletteRow[];
  /** The Objects row that cannot be selected, while names load or after they failed. */
  status?: string;
}

/** Rows without a query and with one (spec C §6.2). Pages and Objects need a query. */
export const CAPS: Record<SectionId, { idle: number; query: number }> = {
  commands: { idle: 6, query: 8 },
  clusters: { idle: 8, query: 6 },
  pages: { idle: 0, query: 8 },
  objects: { idle: 0, query: 12 },
};

export function commandEntries(
  ctx: CommandContext,
  mac: boolean,
): PaletteEntry[] {
  return COMMANDS.filter((c) => c.available(ctx)).map((c) => ({
    key: c.id,
    testId: `palette-command-${c.id}`,
    label: c.label(ctx),
    hint: c.shortcut ? shortKeys(c.shortcut, mac) : "Command",
    icon: c.icon,
    run: (context) => c.run(context),
  }));
}

export function clusterEntries(clusters: ClusterEntry[]): PaletteEntry[] {
  return clusters.map((c) => ({
    key: c.id,
    testId: `palette-cluster-${c.id}`,
    label: c.name,
    hint: clusterStatus(c.state).label,
    icon: Server,
    run: (ctx) => {
      // A newly opened cluster screen connects a disconnected cluster itself. The
      // open screen does not connect again after a disconnect, so its row does.
      const open = ctx.cluster?.id === c.id ? ctx.cluster.state.status : null;
      if (open === "disconnected" || open === "failed") {
        void connectCluster(c.id);
      } else {
        ctx.navigate(`/cluster/${encodeURIComponent(c.id)}`);
      }
    },
  }));
}

/** Overview, the section overviews, then the sidebar's items in its order. */
export function pageEntries(
  clusterId: string,
  resources: ApiResourceInfo[],
): PaletteEntry[] {
  const base = `/cluster/${encodeURIComponent(clusterId)}`;
  const page = (
    path: string,
    label: string,
    icon: LucideIcon,
    to: string,
  ): PaletteEntry => ({
    key: path,
    testId: `palette-page-${path}`,
    label,
    hint: "Page",
    icon,
    run: (ctx) => ctx.navigate(to),
  });
  const sections = visibleSections(resources);
  const out = [page("overview", "Overview", OVERVIEW_ICON, base)];
  for (const section of sections) {
    if (section.overview !== undefined) {
      out.push(
        page(
          section.overview,
          `${section.label} overview`,
          OVERVIEW_ICON,
          `${base}/${section.overview}`,
        ),
      );
    }
  }
  for (const section of sections) {
    const sectionIcon = SECTION_ICONS[section.id] ?? FALLBACK_ICON;
    for (const item of section.items) {
      if (item.type === "route") {
        const icon = ROUTE_ICONS[item.path] ?? sectionIcon;
        out.push(page(item.path, item.label, icon, `${base}/${item.path}`));
      } else {
        const path = `r/${groupSegment(item.group)}/${item.plural}`;
        const icon = KIND_ICONS[item.plural] ?? sectionIcon;
        const to = resourcePath(clusterId, item.group, item.plural);
        out.push(page(path, item.label, icon, to));
      }
    }
  }
  for (const group of customResourceGroups(resources)) {
    for (const item of group.items) {
      const to = resourcePath(clusterId, group.group, item.plural);
      out.push(
        page(`r/${group.group}/${item.plural}`, item.label, CUSTOM_ICON, to),
      );
    }
  }
  return out;
}

export function objectEntries(
  clusterId: string,
  items: ObjectName[],
): PaletteEntry[] {
  return items.map((o) => {
    const scoped = o.namespace === null ? o.name : `${o.namespace}-${o.name}`;
    // The key `ResourceScreen` compares with `?object=`.
    const objectKey = `${o.namespace ?? ""}/${o.name}`;
    const list = resourcePath(clusterId, o.group, o.plural);
    return {
      key: `${o.group}/${o.plural}/${objectKey}`,
      testId: `palette-object-${o.plural}-${scoped}`,
      label: o.name,
      hint: o.namespace === null ? o.kind : `${o.kind} · ${o.namespace}`,
      icon: KIND_ICONS[o.plural] ?? FALLBACK_ICON,
      run: (ctx) =>
        ctx.navigate(`${list}?object=${encodeURIComponent(objectKey)}`),
    };
  });
}

export interface PaletteInput {
  query: string;
  clusterName: string;
  commands: PaletteEntry[];
  clusters: PaletteEntry[];
  /** Null off a connected cluster. */
  pages: PaletteEntry[] | null;
  /** Null off a connected cluster, and while names load or after they failed. */
  objects: PaletteEntry[] | null;
  objectsStatus: string | null;
}

function idle(entries: PaletteEntry[], cap: number): PaletteRow[] {
  return entries.slice(0, cap).map((e) => ({ ...e, score: 0, ranges: [] }));
}

function ranked(
  entries: PaletteEntry[],
  query: string,
  withHint: boolean,
  cap: number,
): PaletteRow[] {
  const rows: PaletteRow[] = [];
  for (const e of entries) {
    const match = matchEntry(query, e.label, withHint ? e.hint : null);
    if (match !== null)
      rows.push({ ...e, score: match.score, ranges: match.ranges });
  }
  // Array.prototype.sort is stable: equal scores keep the list's order.
  rows.sort((a, b) => b.score - a.score);
  return rows.slice(0, cap);
}

export function buildSections(input: PaletteInput): PaletteSection[] {
  const { query } = input;
  if (isBlank(query)) {
    const sections: PaletteSection[] = [
      {
        id: "commands",
        heading: "Commands",
        rows: idle(input.commands, CAPS.commands.idle),
      },
      {
        id: "clusters",
        heading: "Clusters",
        rows: idle(input.clusters, CAPS.clusters.idle),
      },
    ];
    return sections.filter((s) => s.rows.length > 0);
  }
  const sections: PaletteSection[] = [
    {
      id: "commands",
      heading: "Commands",
      rows: ranked(input.commands, query, false, CAPS.commands.query),
    },
    {
      id: "clusters",
      heading: "Clusters",
      rows: ranked(input.clusters, query, true, CAPS.clusters.query),
    },
  ];
  if (input.pages !== null) {
    sections.push({
      id: "pages",
      heading: `Pages in ${input.clusterName}`,
      rows: ranked(input.pages, query, false, CAPS.pages.query),
    });
  }
  if (input.objects !== null) {
    sections.push({
      id: "objects",
      heading: `Objects in ${input.clusterName}`,
      rows: ranked(input.objects, query, true, CAPS.objects.query),
    });
  }
  const shown = sections
    .filter((s) => s.rows.length > 0)
    .sort((a, b) => b.rows[0].score - a.rows[0].score);
  if (input.objects === null && input.objectsStatus !== null) {
    shown.push({
      id: "objects",
      heading: `Objects in ${input.clusterName}`,
      rows: [],
      status: input.objectsStatus,
    });
  }
  return shown;
}
