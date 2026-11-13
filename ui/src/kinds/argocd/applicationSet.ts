import { isText, list, NONE, type Obj, text } from "./common";

const GENERATOR_LABELS: Record<string, string> = {
  list: "List",
  clusters: "Clusters",
  git: "Git",
  scmProvider: "SCM provider",
  clusterDecisionResource: "Cluster decision resource",
  pullRequest: "Pull request",
  matrix: "Matrix",
  merge: "Merge",
  plugin: "Plugin",
  oci: "OCI",
};

/** The generator's type: its first key that is not `selector`. */
function generatorKey(g: unknown): string | undefined {
  if (typeof g !== "object" || g === null || Array.isArray(g)) return undefined;
  return Object.keys(g).find((k) => k !== "selector");
}

function label(key: string): string {
  return Object.hasOwn(GENERATOR_LABELS, key) ? GENERATOR_LABELS[key] : key;
}

function labels(generators: unknown): string[] {
  return list(generators)
    .map(generatorKey)
    .filter((k): k is string => k !== undefined)
    .map(label);
}

export function generatorTypes(o: Obj): string[] {
  return labels(o.spec?.generators);
}

export function generatorText(o: Obj): string {
  const types = generatorTypes(o);
  return types.length > 0 ? types.join(", ") : NONE;
}

function paths(entries: unknown): string[] {
  return list(entries)
    .map((e) => e?.path)
    .filter(isText);
}

// biome-ignore lint/suspicious/noExplicitAny: generator bodies vary by type.
function summary(key: string, value: any): string {
  switch (key) {
    case "git": {
      const where = `${text(value?.repoURL) ?? NONE} @ ${text(value?.revision) ?? "HEAD"}`;
      const dirs = paths(value?.directories);
      if (dirs.length > 0) return `${where}, directories ${dirs.join(", ")}`;
      const files = paths(value?.files);
      if (files.length > 0) return `${where}, files ${files.join(", ")}`;
      return where;
    }
    case "list":
      return `${list(value?.elements).length} elements`;
    case "clusters": {
      const match = value?.selector?.matchLabels;
      const pairs =
        typeof match === "object" && match !== null
          ? Object.entries(match).map(([k, v]) => `${k}=${String(v)}`)
          : [];
      return pairs.length > 0 ? pairs.join(", ") : "All clusters";
    }
    case "matrix": {
      const children = labels(value?.generators);
      return children.length > 0 ? children.join(" × ") : NONE;
    }
    case "merge": {
      const children = labels(value?.generators);
      return children.length > 0 ? children.join(" + ") : NONE;
    }
    default:
      return NONE;
  }
}

export function generatorRows(o: Obj): { type: string; summary: string }[] {
  return list(o.spec?.generators).flatMap((g) => {
    const key = generatorKey(g);
    if (key === undefined) return [];
    return [{ type: label(key), summary: summary(key, g[key]) }];
  });
}

export interface GeneratedApp {
  name: string;
  namespace?: string;
  sync: string;
  health: string;
}

export function generatedApps(o: Obj): GeneratedApp[] {
  return list(o.status?.resources)
    .filter((r) => r?.kind === "Application" && isText(r?.name))
    .map((r) => ({
      name: r.name,
      namespace: text(r.namespace),
      sync: text(r.status) ?? NONE,
      health: text(r.health?.status) ?? NONE,
    }));
}

/** How many resources the set reports, or null when it has no `status.resources`. */
export function generatedCount(o: Obj): number | null {
  const resources = o.status?.resources;
  return Array.isArray(resources) ? resources.length : null;
}
