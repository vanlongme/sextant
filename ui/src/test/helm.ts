import type { Channel } from "@tauri-apps/api/core";
import type { ChartSummary } from "../ipc/generated/ChartSummary";
import type { ChartVersion } from "../ipc/generated/ChartVersion";
import type { HelmRelease } from "../ipc/generated/HelmRelease";
import type { HelmReleaseDetail } from "../ipc/generated/HelmReleaseDetail";
import type { HelmReleaseList } from "../ipc/generated/HelmReleaseList";
import type { HelmRevision } from "../ipc/generated/HelmRevision";
import type { IpcError } from "../ipc/generated/IpcError";
import type { SessionEvent } from "../ipc/generated/SessionEvent";
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

export function releaseList(
  releases: HelmRelease[],
  over: Partial<HelmReleaseList> = {},
): HelmReleaseList {
  return { releases, partial: false, failedNamespaces: [], ...over };
}

export interface StartedRun {
  cmd: string;
  args: Record<string, unknown>;
  /** Sends helm output through the call's data channel. */
  data(text: string): void;
  /** Sends a session event through the call's event channel. */
  send(event: SessionEvent): void;
}

const START_COMMANDS = [
  "helm_install_start",
  "helm_upgrade_start",
  "helm_rollback_start",
  "helm_uninstall_start",
];

/**
 * Handlers for the four `*_start` commands, to spread into `mockBackend`. Each call is
 * kept in `started` with its channels and answers with the session id `session-‹n›`.
 */
export function runHandlers(): {
  started: StartedRun[];
  handlers: Record<string, (args: Record<string, unknown>) => unknown>;
} {
  const started: StartedRun[] = [];
  const handlers: Record<string, (args: Record<string, unknown>) => unknown> =
    {};
  for (const cmd of START_COMMANDS) {
    handlers[cmd] = (args) => {
      const onData = args.onData as Channel<ArrayBuffer>;
      const onEvent = args.onEvent as Channel<SessionEvent>;
      started.push({
        cmd,
        args,
        data: (text) =>
          onData.onmessage(
            Uint8Array.from(new TextEncoder().encode(text)).buffer,
          ),
        send: (event) => onEvent.onmessage(event),
      });
      return `session-${started.length}`;
    };
  }
  return { started, handlers };
}
