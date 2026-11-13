import type { Tone } from "../../design/Badge";
import type { StatusInfo } from "../columns";
import { formatAge } from "../objects";
import { isText, list, NONE, type Obj, text } from "./common";

const SHA = /^[0-9a-f]{40}$/i;
const RESOURCES_FINALIZER = "resources-finalizer.argocd.argoproj.io";
const REFRESH = "argocd.argoproj.io/refresh";
const HEALTH_TONE = new Map<string, Tone>([
  ["Healthy", "ok"],
  ["Progressing", "warn"],
  ["Degraded", "danger"],
]);

/** `status.sync.status`: Synced, OutOfSync, or Unknown when missing (spec G §4.1). */
export function syncStatus(o: Obj): StatusInfo {
  const value = text(o.status?.sync?.status);
  if (value === "Synced") return { label: value, tone: "ok" };
  if (value === "OutOfSync") return { label: value, tone: "warn" };
  return { label: value ?? "Unknown", tone: "neutral" };
}

/** `status.health.status`, with the board's tones, or Unknown when missing. */
export function healthStatus(o: Obj): StatusInfo {
  const value = text(o.status?.health?.status);
  return {
    label: value ?? "Unknown",
    tone: (value && HEALTH_TONE.get(value)) || "neutral",
  };
}

/** The first 7 characters of a 40-character hex SHA; anything else as it is. */
export function shortRevision(rev: string): string {
  return SHA.test(rev) ? rev.slice(0, 7) : rev;
}

function revisionList(single: unknown, many: unknown): string[] {
  const one = text(single);
  if (one) return [one];
  return list(many).filter(isText);
}

/** One revision shortened, or the first of several then " +N", or NONE. */
export function revisionsText(single: unknown, many: unknown): string {
  const all = revisionList(single, many);
  if (all.length === 0) return NONE;
  const first = shortRevision(all[0]);
  return all.length === 1 ? first : `${first} +${all.length - 1}`;
}

export function revisionText(o: Obj): string {
  return revisionsText(o.status?.sync?.revision, o.status?.sync?.revisions);
}

/** Every revision in full, for the cell's title. */
export function revisionTitle(o: Obj): string {
  return revisionList(o.status?.sync?.revision, o.status?.sync?.revisions).join(
    ", ",
  );
}

export function isMultiSource(o: Obj): boolean {
  return list(o.spec?.sources).length > 0;
}

export interface AppSource {
  repoURL: string;
  /** The path, else the chart, else NONE. */
  pathOrChart: string;
  /** The target revision, else HEAD. */
  targetRevision: string;
  ref?: string;
}

export function appSources(o: Obj): AppSource[] {
  const raw = isMultiSource(o) ? list(o.spec?.sources) : [o.spec?.source];
  return raw
    .filter((s) => isText(s?.repoURL))
    .map((s) => ({
      repoURL: s.repoURL,
      pathOrChart: text(s.path) ?? text(s.chart) ?? NONE,
      targetRevision: text(s.targetRevision) ?? "HEAD",
      ref: text(s.ref),
    }));
}

/** `<name or server>, namespace <namespace>`, the target alone, or NONE. */
export function destinationText(o: Obj): string {
  const d = o.spec?.destination;
  const target = text(d?.name) ?? text(d?.server);
  const namespace = text(d?.namespace);
  if (!namespace) return target ?? NONE;
  return `${target ?? NONE}, namespace ${namespace}`;
}

/**
 * Auto-sync is on when `spec.syncPolicy.automated` is present and its `enabled` is not
 * false, the rule of `SyncPolicy.IsAutomatedSyncEnabled` in Argo CD.
 */
export function autoSync(o: Obj): {
  on: boolean;
  prune: boolean;
  selfHeal: boolean;
} {
  const automated = o.spec?.syncPolicy?.automated;
  const on =
    automated !== undefined &&
    automated !== null &&
    automated?.enabled !== false;
  return {
    on,
    prune: on && automated?.prune === true,
    selfHeal: on && automated?.selfHeal === true,
  };
}

export function autoSyncText(o: Obj): string {
  const a = autoSync(o);
  if (!a.on) return "Off";
  return [
    "On",
    ...(a.prune ? ["prune"] : []),
    ...(a.selfHeal ? ["self-heal"] : []),
  ].join(", ");
}

/**
 * Where the Application's AppProject is, by the backend's rule (`windows.rs`): the
 * name is `spec.project` or `default`, and it lives where the controller runs
 * (`status.controllerNamespace`), or else beside the Application.
 */
export function projectLocation(o: Obj): { namespace: string; name: string } {
  return {
    name: text(o.spec?.project) ?? "default",
    namespace:
      text(o.status?.controllerNamespace) ?? o.metadata.namespace ?? "",
  };
}

export function isDeleting(o: Obj): boolean {
  return Boolean(o.metadata.deletionTimestamp);
}

/** True when deleting the Application deletes what it deployed (the finalizer). */
export function deletesResources(o: Obj): boolean {
  const finalizers = list((o.metadata as { finalizers?: unknown }).finalizers);
  return finalizers.some(
    (f) =>
      isText(f) &&
      (f === RESOURCES_FINALIZER || f.startsWith(`${RESOURCES_FINALIZER}/`)),
  );
}

/** A refresh asked for and not yet done by the controller. */
export function refreshRequested(o: Obj): "Normal" | "Hard" | null {
  const value = o.metadata.annotations?.[REFRESH];
  if (value === undefined) return null;
  return value === "hard" ? "Hard" : "Normal";
}

export function initiatedByText(x: unknown): string {
  const by = x as { automated?: unknown; username?: unknown } | undefined;
  if (by?.automated === true) return "Automated";
  return text(by?.username) ?? NONE;
}

function hasOperation(o: Obj): boolean {
  return (
    o.operation !== undefined &&
    o.operation !== null &&
    typeof o.operation === "object"
  );
}

function operationState(o: Obj): Record<string, unknown> | null {
  const state = o.status?.operationState;
  return typeof state === "object" && state !== null && !Array.isArray(state)
    ? state
    : null;
}

/** The note at the top of the drawer while an operation is waiting or running. */
export function operationNote(o: Obj, now: number): string | null {
  const state = operationState(o);
  const phase = text(state?.phase);
  if (phase === "Terminating") return "The running operation is terminating.";
  if (phase === "Running") {
    const who = initiatedByText(
      o.operation?.initiatedBy ??
        (state?.operation as { initiatedBy?: unknown } | undefined)
          ?.initiatedBy,
    );
    const age = formatAge(text(state?.startedAt), now);
    return `An operation has been running for ${age}, started by ${who}. Terminate stops it.`;
  }
  if (hasOperation(o)) {
    return "An operation is waiting for the Argo CD controller to start it.";
  }
  return null;
}

/** The backend's own condition for terminate (`terminating` in `operation.rs`). */
export function canTerminate(o: Obj): boolean {
  return hasOperation(o) && operationState(o) !== null;
}

export interface LastOperation {
  phase: string;
  message: string;
  startedAt?: string;
  finishedAt?: string;
  initiatedBy: string;
}

export function lastOperation(o: Obj): LastOperation | null {
  const state = operationState(o);
  if (!state) return null;
  return {
    phase: text(state.phase) ?? NONE,
    message: text(state.message) ?? NONE,
    startedAt: text(state.startedAt),
    finishedAt: text(state.finishedAt),
    initiatedBy: initiatedByText(
      (state.operation as { initiatedBy?: unknown } | undefined)?.initiatedBy,
    ),
  };
}

export interface HistoryEntry {
  id: number;
  revision: string;
  deployedAt?: string;
  initiatedBy: string;
}

/** `status.history`, newest first by id; entries without a numeric id are left out. */
export function appHistory(o: Obj): HistoryEntry[] {
  return list(o.status?.history)
    .filter((h) => typeof h?.id === "number")
    .map((h) => ({
      id: h.id as number,
      revision: revisionsText(h.revision, h.revisions),
      deployedAt: text(h.deployedAt),
      initiatedBy: initiatedByText(h.initiatedBy),
    }))
    .sort((a, b) => b.id - a.id);
}

/** What a roll back can deploy again: every entry but the newest. */
export function rollbackTargets(o: Obj): HistoryEntry[] {
  return appHistory(o).slice(1);
}

export function rollbackRefusal(o: Obj): string | null {
  if (autoSync(o).on)
    return "Auto-sync is on. Turn it off before rolling back.";
  if (rollbackTargets(o).length === 0) {
    return "There is no earlier deployment to roll back to.";
  }
  return null;
}

export interface AppResource {
  apiVersion: string;
  kind: string;
  namespace?: string;
  name: string;
  sync: string;
  health: string;
}

/** `status.resources`; per-resource health is optional (NONE). */
export function appResources(o: Obj): AppResource[] {
  return list(o.status?.resources)
    .filter((r) => isText(r?.kind) && isText(r?.name))
    .map((r) => {
      const version = text(r.version) ?? "v1";
      const group = text(r.group);
      return {
        apiVersion: group ? `${group}/${version}` : version,
        kind: r.kind,
        namespace: text(r.namespace),
        name: r.name,
        sync: text(r.status) ?? NONE,
        health: text(r.health?.status) ?? NONE,
      };
    });
}
