export interface KubeObject {
  apiVersion?: string;
  kind?: string;
  metadata: {
    name: string;
    namespace?: string;
    uid?: string;
    creationTimestamp?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    ownerReferences?: {
      kind: string;
      name: string;
      uid: string;
      controller?: boolean;
    }[];
    resourceVersion?: string;
    deletionTimestamp?: string;
  };
  // biome-ignore lint/suspicious/noExplicitAny: the shape depends on the kind.
  spec?: any;
  // biome-ignore lint/suspicious/noExplicitAny: the shape depends on the kind.
  status?: any;
  // biome-ignore lint/suspicious/noExplicitAny: other top-level fields vary by kind.
  [k: string]: any;
}

/** `<namespace>/<name>`, or `/<name>` for a cluster-scoped object. */
export function objectKey(o: Pick<KubeObject, "metadata">): string {
  return `${o.metadata.namespace ?? ""}/${o.metadata.name}`;
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const YEAR = 365 * DAY;

/** A unit and its remainder in the next unit, with a zero remainder left out. */
function pair(
  total: number,
  unit: number,
  big: string,
  rest: number,
  small: string,
) {
  const head = Math.floor(total / unit);
  const tail = Math.floor((total % unit) / rest);
  return `${head}${big}${tail > 0 ? `${tail}${small}` : ""}`;
}

/** An age in kubectl's style: `5s`, `3m20s`, `5h30m`, `2d3h`, `40d`. */
export function formatAge(fromIso: string | undefined, now: number): string {
  if (!fromIso) return "-";
  const from = Date.parse(fromIso);
  if (Number.isNaN(from)) return "-";
  const seconds = Math.max(0, Math.floor((now - from) / 1000));
  if (seconds < MINUTE) return `${seconds}s`;
  if (seconds < 10 * MINUTE) return pair(seconds, MINUTE, "m", 1, "s");
  if (seconds < HOUR) return `${Math.floor(seconds / MINUTE)}m`;
  if (seconds < 8 * HOUR) return pair(seconds, HOUR, "h", MINUTE, "m");
  if (seconds < 2 * DAY) return `${Math.floor(seconds / HOUR)}h`;
  if (seconds < 8 * DAY) return pair(seconds, DAY, "d", HOUR, "h");
  if (seconds < 2 * YEAR) return `${Math.floor(seconds / DAY)}d`;
  return pair(seconds, YEAR, "y", DAY, "d");
}
