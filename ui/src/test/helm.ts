import type { ChartSummary } from "../ipc/generated/ChartSummary";
import type { ChartVersion } from "../ipc/generated/ChartVersion";
import type { HelmRelease } from "../ipc/generated/HelmRelease";
import type { HelmReleaseDetail } from "../ipc/generated/HelmReleaseDetail";
import type { HelmRevision } from "../ipc/generated/HelmRevision";
import type { IpcError } from "../ipc/generated/IpcError";
import type { ToolName } from "../ipc/generated/ToolName";
import type { ToolStatus } from "../ipc/generated/ToolStatus";

/** What a handler throws to make a call reject with ToolMissing. */
export const HELM_MISSING: IpcError = {
  code: "ToolMissing",
  message: "helm is not on PATH and no path is set",
  details: "helm",
};

export function toolStatus(
  over: Partial<ToolStatus> & { tool: ToolName },
): ToolStatus {
  return {
    source: "path",
    path: `/usr/local/bin/${over.tool}`,
    version: "v4.3.1",
    problem: null,
    managedVersion: "v4.3.1",
    managedInstalled: false,
    downloading: false,
    ...over,
  };
}

export function chartVersion(over: Partial<ChartVersion> = {}): ChartVersion {
  return {
    version: "1.2.3",
    appVersion: "1.25.0",
    description: "A web server",
    created: "2026-11-01T10:00:00Z",
    deprecated: false,
    ...over,
  };
}

export function chart(
  over: Partial<ChartSummary> & { name: string },
): ChartSummary {
  return { repo: "bitnami", latest: chartVersion(), keywords: [], ...over };
}

export function release(
  over: Partial<HelmRelease> & { name: string },
): HelmRelease {
  return {
    namespace: "shop",
    revision: 1,
    status: "deployed",
    chart: "nginx-1.2.3",
    chartName: "nginx",
    chartVersion: "1.2.3",
    appVersion: "1.25.0",
    updated: "2026-11-10T09:00:00Z",
    ...over,
  };
}

export function detail(
  over: Partial<HelmReleaseDetail> & { name: string },
): HelmReleaseDetail {
  return {
    ...release(over),
    description: "Install complete",
    notes: null,
    firstDeployed: "2026-11-09T08:00:00Z",
    lastDeployed: "2026-11-10T09:00:00Z",
    resources: [],
    manifest: "",
    ...over,
  };
}

export function revision(
  over: Partial<HelmRevision> & { revision: number },
): HelmRevision {
  return {
    updated: "2026-11-10T09:00:00Z",
    status: "superseded",
    chart: "nginx-1.2.3",
    appVersion: "1.25.0",
    description: "Upgrade complete",
    ...over,
  };
}
