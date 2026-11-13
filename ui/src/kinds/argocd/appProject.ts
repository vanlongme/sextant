import { projectLocation } from "./application";
import { firstAndMore, isText, list, NONE, type Obj, text } from "./common";

export interface ProjectDestination {
  target: string;
  namespace: string;
}

export function projectDestinations(o: Obj): ProjectDestination[] {
  return list(o.spec?.destinations)
    .filter((d) => typeof d === "object" && d !== null)
    .map((d) => ({
      target: text(d.name) ?? text(d.server) ?? "*",
      namespace: text(d.namespace) ?? "*",
    }));
}

function namespaces(o: Obj): string[] {
  return [...new Set(projectDestinations(o).map((d) => d.namespace))];
}

export function destinationsText(o: Obj): string {
  return firstAndMore(namespaces(o));
}

export function destinationsTitle(o: Obj): string {
  return namespaces(o).join(", ");
}

const SCHEME = /^https?:\/\//;

function repos(o: Obj): string[] {
  return list(o.spec?.sourceRepos)
    .filter(isText)
    .map((r) => r.replace(SCHEME, ""));
}

export function sourceReposText(o: Obj): string {
  return firstAndMore(repos(o));
}

export function sourceReposTitle(o: Obj): string {
  return repos(o).join(", ");
}

export interface SyncWindow {
  kind: string;
  schedule: string;
  duration: string;
  timeZone?: string;
  /** "Applications: a, b; Namespaces: x; Clusters: y", the lists that are set. */
  scope: string;
  manualSync: boolean;
}

// biome-ignore lint/suspicious/noExplicitAny: windows are read field by field.
function scopeText(w: any): string {
  const parts = (
    [
      ["Applications", w.applications],
      ["Namespaces", w.namespaces],
      ["Clusters", w.clusters],
    ] as const
  )
    .map(([name, values]) => [name, list(values).filter(isText)] as const)
    .filter(([, values]) => values.length > 0)
    .map(([name, values]) => `${name}: ${values.join(", ")}`);
  return parts.length > 0 ? parts.join("; ") : NONE;
}

export function syncWindows(o: Obj): SyncWindow[] {
  return list(o.spec?.syncWindows)
    .filter((w) => typeof w === "object" && w !== null)
    .map((w) => ({
      kind: text(w.kind) ?? NONE,
      schedule: text(w.schedule) ?? NONE,
      duration: text(w.duration) ?? NONE,
      timeZone: text(w.timeZone),
      scope: scopeText(w),
      manualSync: w.manualSync === true,
    }));
}

/** True when the Application's project location is this AppProject. */
export function belongsTo(app: Obj, project: Obj): boolean {
  const at = projectLocation(app);
  return (
    at.name === project.metadata.name &&
    at.namespace === (project.metadata.namespace ?? "")
  );
}
