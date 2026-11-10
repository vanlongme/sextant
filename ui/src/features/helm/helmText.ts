import type { HelmRelease } from "../../ipc/generated/HelmRelease";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import { resourcePath } from "../../kinds/nav";
import { formatAge } from "../../kinds/objects";
import { type HelmRun, releaseIsBusy } from "../../stores/helm";

export type Tone = "ok" | "warn" | "danger" | "info" | "neutral";

const STATUS_TONES: Record<string, Tone> = {
  deployed: "ok",
  failed: "danger",
  superseded: "neutral",
  uninstalled: "neutral",
  "pending-install": "warn",
  "pending-upgrade": "warn",
  "pending-rollback": "warn",
  uninstalling: "warn",
};

/** The badge tone of a release or revision status (spec §8). */
export function statusTone(status: string): Tone {
  return STATUS_TONES[status] ?? "neutral";
}

/** "‹age› ago", or "—" without a time. */
export function ago(iso: string | null, now: number): string {
  const age = formatAge(iso ?? undefined, now);
  return age === "-" ? "—" : `${age} ago`;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "yyyy-mm-dd hh:mm:ss UTC · ‹age› ago", or "—" (spec §9). */
export function utcTime(iso: string | null, now: number): string {
  const at = iso === null ? Number.NaN : Date.parse(iso);
  if (Number.isNaN(at)) return "—";
  const d = new Date(at);
  const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return `${day} ${time} UTC · ${ago(iso, now)}`;
}

/** "1.2.3 · app 1.25.0"; a missing part drops out. */
export function versionText(
  version: string | null,
  appVersion: string | null,
): string {
  return [version, appVersion === null ? null : `app ${appVersion}`]
    .filter((part) => part !== null)
    .join(" · ");
}

const base = (clusterId: string) => `/cluster/${encodeURIComponent(clusterId)}`;

/**
 * `‹a›/‹b›` with each part URI-encoded: the value of a drawer parameter, which
 * `URLSearchParams` then encodes as a whole.
 */
export function pairParam(first: string, second: string): string {
  return `${encodeURIComponent(first)}/${encodeURIComponent(second)}`;
}

/** Reads a `pairParam` back; null unless it holds exactly two non-empty parts. */
export function parsePair(
  value: string | null,
): { first: string; second: string } | null {
  if (value === null) return null;
  const parts = value.split("/");
  if (parts.length !== 2) return null;
  try {
    const [first, second] = parts.map(decodeURIComponent);
    if (!first || !second) return null;
    return { first, second };
  } catch {
    return null;
  }
}

export function chartsPath(
  clusterId: string,
  chart?: { repo: string; name: string },
): string {
  const path = `${base(clusterId)}/helm/charts`;
  if (!chart) return path;
  return `${path}?${new URLSearchParams({ chart: pairParam(chart.repo, chart.name) })}`;
}

export function releasesPath(
  clusterId: string,
  release?: { namespace: string; name: string },
): string {
  const path = `${base(clusterId)}/helm/releases`;
  if (!release) return path;
  return `${path}?${new URLSearchParams({ release: pairParam(release.namespace, release.name) })}`;
}

export function installPath(
  clusterId: string,
  repo: string,
  chart: string,
  version?: string,
): string {
  const params = new URLSearchParams({ repo, chart });
  if (version !== undefined) params.set("version", version);
  return `${base(clusterId)}/helm/install?${params.toString()}`;
}

export function upgradePath(
  clusterId: string,
  namespace: string,
  name: string,
): string {
  return `${base(clusterId)}/helm/upgrade/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`;
}

/** The drawer route of an object a release created. */
export function objectPath(
  clusterId: string,
  ref: ResourceRef,
  namespace: string | null,
  name: string,
): string {
  const ns = ref.namespaced ? (namespace ?? "") : "";
  return `${resourcePath(clusterId, ref.group, ref.plural)}?object=${encodeURIComponent(`${ns}/${name}`)}`;
}

/** The drawer route of a Namespace object. */
export function namespacePath(clusterId: string, namespace: string): string {
  return `${resourcePath(clusterId, "", "namespaces")}?object=${encodeURIComponent(`/${namespace}`)}`;
}

export interface ReleaseActions {
  upgrade: boolean;
  rollback: boolean;
  uninstall: boolean;
}

/**
 * Which actions a release offers (spec §5.3): none while busy, only Uninstall when
 * uninstalled, and Roll back only with an earlier revision to go back to.
 */
export function releaseActions(
  release: Pick<HelmRelease, "status">,
  run: HelmRun | undefined,
  revisions: number,
): ReleaseActions {
  if (releaseIsBusy(release, run)) {
    return { upgrade: false, rollback: false, uninstall: false };
  }
  if (release.status === "uninstalled") {
    return { upgrade: false, rollback: false, uninstall: true };
  }
  return { upgrade: true, rollback: revisions > 1, uninstall: true };
}
