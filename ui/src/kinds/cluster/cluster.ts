import type { StatusInfo } from "../columns";
import type { KubeObject } from "../objects";

type Obj = Pick<KubeObject, "metadata"> & Partial<KubeObject>;

export function namespaceStatus(o: Obj): StatusInfo {
  const phase: unknown = o.status?.phase;
  if (typeof phase !== "string" || phase === "") {
    return { label: "Unknown", tone: "neutral" };
  }
  return { label: phase, tone: phase === "Active" ? "ok" : "neutral" };
}

export function eventStatus(o: Obj): StatusInfo {
  const type = typeof o.type === "string" && o.type ? o.type : "Unknown";
  if (type === "Warning") return { label: type, tone: "warn" };
  if (type === "Normal") return { label: type, tone: "info" };
  return { label: type, tone: "neutral" };
}

/** How often an event happened, as kubectl counts: the series, else `count`, else once. */
export function eventCount(o: Obj): number {
  const count = o.series ? o.series.count : o.count;
  return typeof count === "number" && count > 0 ? count : 1;
}

/** `<kind>/<name>` of the object an event is about. */
export function eventObjectText(o: Obj): string {
  const target = o.involvedObject ?? o.regarding;
  if (!target?.kind || !target?.name) return "";
  return `${target.kind}/${target.name}`;
}

/** The newest time an event carries, as it was written. */
export function eventLastSeen(o: Obj): string | undefined {
  const candidates: unknown[] = [
    o.lastTimestamp,
    o.series?.lastObservedTime,
    o.eventTime,
    o.firstTimestamp,
    o.metadata.creationTimestamp,
  ];
  let best: string | undefined;
  let bestTime = Number.NEGATIVE_INFINITY;
  for (const value of candidates) {
    if (typeof value !== "string") continue;
    const time = Date.parse(value);
    if (Number.isNaN(time) || time <= bestTime) continue;
    best = value;
    bestTime = time;
  }
  return best;
}

export interface CrdVersion {
  name: string;
  served?: boolean;
  storage?: boolean;
  schema?: { openAPIV3Schema?: unknown };
  additionalPrinterColumns?: unknown[];
}

interface RawPrinterColumn {
  name?: unknown;
  type?: unknown;
  jsonPath?: unknown;
  priority?: unknown;
  description?: unknown;
}

export function crdVersions(o: Obj): CrdVersion[] {
  const versions: unknown = o.spec?.versions;
  return Array.isArray(versions)
    ? versions.filter(
        (v): v is CrdVersion => typeof v === "object" && v !== null,
      )
    : [];
}

/** The served storage version, else the first served one. */
export function preferredVersion(o: Obj): CrdVersion | undefined {
  const served = crdVersions(o).filter((v) => v.served !== false);
  return served.find((v) => v.storage) ?? served[0];
}

/** The Versions column: the names of the served versions. */
export function servedVersionNames(o: Obj): string {
  return crdVersions(o)
    .filter((v) => v.served !== false)
    .map((v) => v.name)
    .join(",");
}

export interface PrinterColumnRow {
  name: string;
  type: string;
  jsonPath: string;
  priority: string;
  description: string;
}

export function printerColumnRows(
  version: Pick<CrdVersion, "name" | "additionalPrinterColumns"> | undefined,
): PrinterColumnRow[] {
  const columns = version?.additionalPrinterColumns;
  if (!Array.isArray(columns)) return [];
  return columns
    .filter((c): c is RawPrinterColumn => typeof c === "object" && c !== null)
    .map((c) => ({
      name: String(c.name ?? ""),
      type: String(c.type ?? ""),
      jsonPath: String(c.jsonPath ?? ""),
      priority: String(c.priority ?? 0),
      description: String(c.description ?? ""),
    }));
}
