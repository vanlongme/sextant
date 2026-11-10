import { create } from "zustand";
import { toast } from "../design";
import { api } from "../ipc/api";
import { IpcFailure } from "../ipc/client";
import { events } from "../ipc/events";
import type { ChartSearch } from "../ipc/generated/ChartSearch";
import type { HelmInstallRequest } from "../ipc/generated/HelmInstallRequest";
import type { HelmRelease } from "../ipc/generated/HelmRelease";
import type { HelmReleaseList } from "../ipc/generated/HelmReleaseList";
import type { HelmRepo } from "../ipc/generated/HelmRepo";
import type { HelmRepoAdd } from "../ipc/generated/HelmRepoAdd";
import type { HelmUpgradeRequest } from "../ipc/generated/HelmUpgradeRequest";
import type { SessionEvent } from "../ipc/generated/SessionEvent";
import type { ToolName } from "../ipc/generated/ToolName";
import type { ToolProgress } from "../ipc/generated/ToolProgress";
import type { ToolStatus } from "../ipc/generated/ToolStatus";
import { useCatalog } from "./catalog";

/** Every failure the store keeps is an `IpcFailure`, so a screen can tell ToolMissing apart. */
export function asFailure(error: unknown): IpcFailure {
  if (error instanceof IpcFailure) return error;
  return new IpcFailure(
    "Internal",
    error instanceof Error ? error.message : String(error),
  );
}

export function isToolMissing(error: unknown): boolean {
  return error instanceof IpcFailure && error.code === "ToolMissing";
}

/** Whether helm can run: found somewhere, and not a preferences path that is broken. */
export function toolUsable(status: ToolStatus): boolean {
  return (
    status.source !== "missing" &&
    !(status.source === "preferences" && status.problem)
  );
}

/** "1 chart", "2 charts". */
export function counted(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export interface ToolsSlice {
  /** The last `tools_status` answer. */
  status: ToolStatus[] | null;
  error: IpcFailure | null;
  /** The last progress of each tool's download. A refused download is recorded as `failed`. */
  progress: Partial<Record<ToolName, ToolProgress>>;
}

export interface ReposSlice {
  /** helm's repositories, or null until read or when the read failed. */
  list: HelmRepo[] | null;
  error: IpcFailure | null;
  /** The repositories an update is running for. */
  updating: string[];
}

export interface ChartsSlice {
  /** `helm_chart_search("", null)`, or null until read or when the read failed. */
  search: ChartSearch | null;
  error: IpcFailure | null;
  loading: boolean;
}

export interface HelmState {
  tools: ToolsSlice;
  repos: ReposSlice;
  charts: ChartsSlice;
  /** Subscribes to `tools://progress` once, and reads the status unless it has it. */
  ensureTools(): Promise<void>;
  loadTools(): Promise<void>;
  /** Downloads the managed copy; toasts when it is ready. Never rejects. */
  downloadTool(tool: ToolName): Promise<void>;
  cancelDownload(tool: ToolName): Promise<void>;
  /** Reads the repositories unless they were read or are being read. */
  ensureRepos(): Promise<void>;
  loadRepos(): Promise<void>;
  /**
   * Runs `helm repo add`. A refusal rejects with its `IpcFailure`. On success the
   * repositories and charts reload, then a toast counts the new repository's charts.
   */
  addRepo(repo: HelmRepoAdd): Promise<void>;
  /** True once removed; a failure toasts and gives false. */
  removeRepo(name: string): Promise<boolean>;
  /** Null updates every repository. Toasts at the start and the end; the charts reload. */
  updateRepos(names: string[] | null): Promise<void>;
  /** Reads the charts unless they were read, are being read, or the last read failed. */
  ensureCharts(): Promise<void>;
  loadCharts(): Promise<void>;
  /** Per cluster id. */
  releases: Record<string, ReleasesSlice>;
  /** Per `runKey`; a run stays until another starts on the key or its cluster disconnects. */
  runs: Record<string, HelmRun>;
  /**
   * Loads the cluster's releases now and every 15 s while the document is visible,
   * until every watcher has called the returned function.
   */
  watchReleases(clusterId: string, namespaces: string[] | null): () => void;
  /** Leaving out `namespaces` asks for the ones of the last read. */
  loadReleases(clusterId: string, namespaces?: string[] | null): Promise<void>;
  startInstall(clusterId: string, request: HelmInstallRequest): Promise<void>;
  startUpgrade(clusterId: string, request: HelmUpgradeRequest): Promise<void>;
  startRollback(
    clusterId: string,
    namespace: string,
    release: string,
    revision: number,
  ): Promise<void>;
  startUninstall(
    clusterId: string,
    namespace: string,
    release: string,
    keepHistory: boolean,
  ): Promise<void>;
  /** Asks helm to stop; the run ends as `stopped` when the session says so. */
  stopRun(key: string): void;
  /**
   * Marks the install or upgrade page of the key as open, so its run does not toast.
   * Returns the function that marks it closed.
   */
  showRunPage(key: string): () => void;
}

const CHECKSUM_FAILED =
  "the downloaded file does not match its pinned SHA-256 checksum";

/** The backend's fixed message when a download fails its checksum (contract §2). */
export function isChecksumFailure(progress: ToolProgress | undefined): boolean {
  return (
    progress?.phase === "failed" &&
    progress.error?.code === "Internal" &&
    progress.error.message === CHECKSUM_FAILED
  );
}

const FIRST = {
  tools: { status: null, error: null, progress: {} },
  repos: { list: null, error: null, updating: [] },
  charts: { search: null, error: null, loading: false },
  releases: {},
  runs: {},
} satisfies Partial<HelmState>;

let subscribed: Promise<void> | null = null;
let toolsLoading: Promise<void> | null = null;
let reposLoading: Promise<void> | null = null;
let chartsLoading: Promise<void> | null = null;
// Each read takes the next number; only the newest one's answer is kept.
let toolsSeq = 0;
let reposSeq = 0;
let chartsSeq = 0;
const downloading = new Set<ToolName>();
const releaseSeq = new Map<string, number>();
const releaseLoads = new Map<string, { asked: string; read: Promise<void> }>();
const watchers = new Map<string, { count: number; timer: number }>();
const openPages = new Map<string, number>();
const stopWanted = new Set<number>();
let runSeq = 0;
let unwatchCatalog: (() => void) | null = null;

export const useHelm = create<HelmState>((set, get) => {
  function setProgress(progress: ToolProgress): void {
    set((s) => ({
      tools: {
        ...s.tools,
        progress: { ...s.tools.progress, [progress.tool]: progress },
      },
    }));
  }

  return {
    ...FIRST,

    ensureTools() {
      if (!subscribed) {
        subscribed = events
          .onToolsProgress((progress) => {
            setProgress(progress);
            if (progress.phase === "done" || progress.phase === "failed") {
              void get().loadTools();
            }
          })
          .then(() => {});
      }
      const { status } = get().tools;
      const load = status === null ? (toolsLoading ?? get().loadTools()) : null;
      return Promise.all([subscribed, load]).then(() => {});
    },

    loadTools() {
      const mine = ++toolsSeq;
      const read = (async () => {
        try {
          const status = await api.toolsStatus();
          if (mine === toolsSeq) {
            set((s) => ({ tools: { ...s.tools, status, error: null } }));
            // Helm may have just been downloaded: screens stuck on ToolMissing load again.
            const helmStatus = status.find((t) => t.tool === "helm");
            if (helmStatus && toolUsable(helmStatus)) {
              if (isToolMissing(get().repos.error)) void get().loadRepos();
              if (isToolMissing(get().charts.error)) void get().loadCharts();
            }
          }
        } catch (error) {
          if (mine === toolsSeq) {
            set((s) => ({ tools: { ...s.tools, error: asFailure(error) } }));
          }
        } finally {
          if (mine === toolsSeq) toolsLoading = null;
        }
      })();
      toolsLoading = read;
      return read;
    },

    async downloadTool(tool) {
      if (downloading.has(tool)) return;
      downloading.add(tool);
      setProgress({
        tool,
        phase: "downloading",
        receivedBytes: 0,
        totalBytes: null,
        error: null,
      });
      try {
        const status = await api.toolsDownload(tool);
        const last = get().tools.progress[tool];
        if (last) setProgress({ ...last, phase: "done", error: null });
        const name = status.version ? `${tool} ${status.version}` : tool;
        toast.success(
          `${name} is ready`,
          status.path
            ? `Checksum verified · ${status.path}`
            : "Checksum verified",
        );
      } catch (error) {
        const failure = asFailure(error);
        const last = get().tools.progress[tool];
        setProgress({
          tool,
          phase: "failed",
          receivedBytes: last?.receivedBytes ?? 0,
          totalBytes: last?.totalBytes ?? null,
          error: {
            code: failure.code,
            message: failure.message,
            details: failure.details ?? null,
          },
        });
      } finally {
        downloading.delete(tool);
      }
      await get().loadTools();
    },

    async cancelDownload(tool) {
      try {
        await api.toolsDownloadCancel(tool);
      } catch (error) {
        toast.error("Could not cancel the download", asFailure(error).message);
      }
    },

    ensureRepos() {
      if (get().repos.list !== null) return Promise.resolve();
      return reposLoading ?? get().loadRepos();
    },

    loadRepos() {
      const mine = ++reposSeq;
      const read = (async () => {
        try {
          const list = await api.helmRepoList();
          if (mine === reposSeq) {
            set((s) => ({ repos: { ...s.repos, list, error: null } }));
          }
        } catch (error) {
          if (mine === reposSeq) {
            set((s) => ({
              repos: { ...s.repos, list: null, error: asFailure(error) },
            }));
          }
        } finally {
          if (mine === reposSeq) reposLoading = null;
        }
      })();
      reposLoading = read;
      return read;
    },

    async addRepo(repo) {
      try {
        await api.helmRepoAdd(repo);
      } catch (error) {
        throw asFailure(error);
      }
      await Promise.all([get().loadRepos(), get().loadCharts()]);
      const charts = get().charts.search?.charts ?? [];
      const count = charts.filter((c) => c.repo === repo.name).length;
      toast.success(
        `"${repo.name}" has been added to your repositories`,
        `${counted(count, "chart", "charts")} in its index`,
      );
    },

    async removeRepo(name) {
      try {
        await api.helmRepoRemove(name);
      } catch (error) {
        toast.error(`Could not remove ${name}`, asFailure(error).message);
        return false;
      }
      await Promise.all([get().loadRepos(), get().loadCharts()]);
      return true;
    },

    async updateRepos(names) {
      const which = names ?? (get().repos.list ?? []).map((r) => r.name);
      if (which.length === 0) return;
      set((s) => ({
        repos: {
          ...s.repos,
          updating: [...new Set([...s.repos.updating, ...which])],
        },
      }));
      toast.info(
        which.length === 1
          ? "Updating 1 repository"
          : `Updating ${which.length} repositories`,
        which.join(", "),
      );
      try {
        await api.helmRepoUpdate(names);
        toast.success(
          which.length === 1
            ? `Updated ${which[0]}`
            : `Updated ${which.length} repositories`,
        );
      } catch (error) {
        toast.error(
          "Could not update the repositories",
          asFailure(error).message,
        );
      } finally {
        set((s) => ({
          repos: {
            ...s.repos,
            updating: s.repos.updating.filter((n) => !which.includes(n)),
          },
        }));
      }
      await get().loadCharts();
    },

    ensureCharts() {
      const { search, error } = get().charts;
      if (search !== null || error !== null) return Promise.resolve();
      return chartsLoading ?? get().loadCharts();
    },

    loadCharts() {
      const mine = ++chartsSeq;
      set((s) => ({ charts: { ...s.charts, loading: true } }));
      const read = (async () => {
        try {
          const search = await api.helmChartSearch("", null);
          if (mine === chartsSeq) {
            set({ charts: { search, error: null, loading: false } });
          }
        } catch (error) {
          if (mine === chartsSeq) {
            set({
              charts: { search: null, error: asFailure(error), loading: false },
            });
          }
        } finally {
          if (mine === chartsSeq) chartsLoading = null;
        }
      })();
      chartsLoading = read;
      return read;
    },

    watchReleases(clusterId, namespaces) {
      watchCatalog();
      let watch = watchers.get(clusterId);
      if (!watch) {
        watch = {
          count: 0,
          timer: window.setInterval(() => {
            if (document.visibilityState === "visible") {
              void get().loadReleases(clusterId);
            }
          }, RELEASES_POLL_MS),
        };
        watchers.set(clusterId, watch);
      }
      watch.count += 1;
      void get().loadReleases(clusterId, namespaces);
      const mine = watch;
      let done = false;
      return () => {
        if (done) return;
        done = true;
        mine.count -= 1;
        if (mine.count === 0) {
          window.clearInterval(mine.timer);
          watchers.delete(clusterId);
        }
      };
    },

    loadReleases(clusterId, namespaces) {
      const current = get().releases[clusterId];
      const wanted =
        namespaces === undefined ? (current?.namespaces ?? null) : namespaces;
      const asked = JSON.stringify(wanted);
      const running = releaseLoads.get(clusterId);
      if (running && running.asked === asked) return running.read;
      const same =
        current !== undefined && JSON.stringify(current.namespaces) === asked;
      const mine = (releaseSeq.get(clusterId) ?? 0) + 1;
      releaseSeq.set(clusterId, mine);
      const patch = (change: Partial<ReleasesSlice>) =>
        set((s) => {
          const slice = s.releases[clusterId];
          if (!slice || releaseSeq.get(clusterId) !== mine) return s;
          return {
            releases: { ...s.releases, [clusterId]: { ...slice, ...change } },
          };
        });
      set((s) => ({
        releases: {
          ...s.releases,
          [clusterId]: {
            list: same ? current.list : null,
            error: same ? current.error : null,
            loading: true,
            namespaces: wanted,
          },
        },
      }));
      const read = (async () => {
        try {
          const list = await api.helmReleaseList(clusterId, wanted);
          patch({ list, error: null, loading: false });
        } catch (error) {
          patch({ list: null, error: asFailure(error), loading: false });
        } finally {
          if (releaseSeq.get(clusterId) === mine)
            releaseLoads.delete(clusterId);
        }
      })();
      releaseLoads.set(clusterId, { asked, read });
      return read;
    },

    startInstall(clusterId, request) {
      return begin(
        {
          kind: "install",
          clusterId,
          namespace: request.namespace,
          release: request.releaseName ?? "",
          revision: null,
          keepHistory: false,
        },
        (onData, onEvent) =>
          api.helmInstallStart(clusterId, request, onData, onEvent),
      );
    },

    startUpgrade(clusterId, request) {
      return begin(
        {
          kind: "upgrade",
          clusterId,
          namespace: request.namespace,
          release: request.release,
          revision: null,
          keepHistory: false,
        },
        (onData, onEvent) =>
          api.helmUpgradeStart(clusterId, request, onData, onEvent),
      );
    },

    startRollback(clusterId, namespace, release, revision) {
      return begin(
        {
          kind: "rollback",
          clusterId,
          namespace,
          release,
          revision,
          keepHistory: false,
        },
        (onData, onEvent) =>
          api.helmRollbackStart(
            clusterId,
            namespace,
            release,
            revision,
            true,
            onData,
            onEvent,
          ),
      );
    },

    startUninstall(clusterId, namespace, release, keepHistory) {
      return begin(
        {
          kind: "uninstall",
          clusterId,
          namespace,
          release,
          revision: null,
          keepHistory,
        },
        (onData, onEvent) =>
          api.helmUninstallStart(
            clusterId,
            namespace,
            release,
            true,
            keepHistory,
            onData,
            onEvent,
          ),
      );
    },

    stopRun(key) {
      const run = get().runs[key];
      if (run?.phase !== "running") return;
      if (run.sessionId === null) {
        stopWanted.add(run.id);
        return;
      }
      void api.sessionStop(run.sessionId).catch(() => {});
    },

    showRunPage(key) {
      openPages.set(key, (openPages.get(key) ?? 0) + 1);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        const left = (openPages.get(key) ?? 1) - 1;
        if (left === 0) openPages.delete(key);
        else openPages.set(key, left);
      };
    },
  };

  /** Starts a run under its key, replacing the key's last run. */
  async function begin(
    base: RunBase,
    start: (
      onData: (chunk: ArrayBuffer) => void,
      onEvent: (event: SessionEvent) => void,
    ) => Promise<string>,
  ): Promise<void> {
    watchCatalog();
    const key = runKey(base.clusterId, base.namespace, base.release);
    runSeq += 1;
    const id = runSeq;
    const decoder = new TextDecoder();
    set((s) => ({
      runs: {
        ...s.runs,
        [key]: {
          ...base,
          key,
          id,
          sessionId: null,
          phase: "running",
          output: "",
          error: null,
          rejected: false,
        },
      },
    }));
    const mine = (): HelmRun | null => {
      const run = get().runs[key];
      return run && run.id === id ? run : null;
    };
    const patch = (change: Partial<HelmRun>) => {
      const run = mine();
      if (run)
        set((s) => ({ runs: { ...s.runs, [key]: { ...run, ...change } } }));
    };
    const end = (
      phase: RunPhase,
      error: HelmRun["error"],
      rejected = false,
    ) => {
      const run = mine();
      if (run?.phase !== "running") return;
      patch({ phase, error, rejected, output: run.output + decoder.decode() });
      stopWanted.delete(id);
      const ended = mine();
      if (ended) announceEnd(ended);
      if (get().releases[base.clusterId]) {
        void get().loadReleases(base.clusterId);
      }
    };
    announceStart(base);
    try {
      const sessionId = await start(
        (chunk) => {
          const run = mine();
          if (run?.phase !== "running") return;
          const text = decoder.decode(new Uint8Array(chunk), { stream: true });
          patch({ output: run.output + text });
        },
        (event) => {
          if (event.type === "exited") {
            if (event.code === 0) end("succeeded", null);
            else
              end("failed", {
                message:
                  event.code === null
                    ? "helm exited with no exit code"
                    : `helm exited with code ${event.code}`,
                details: null,
              });
          } else if (event.type === "failed") {
            if (event.error.code === "Cancelled") end("stopped", null);
            else
              end("failed", {
                message: event.error.message,
                details: event.error.details,
              });
          }
        },
      );
      patch({ sessionId });
      if (stopWanted.delete(id) && mine()?.phase === "running") {
        void api.sessionStop(sessionId).catch(() => {});
      }
    } catch (error) {
      const failure = asFailure(error);
      end(
        "failed",
        { message: failure.message, details: failure.details ?? null },
        true,
      );
    }
  }

  /** Drops a cluster's runs and releases when it leaves `connected`. */
  function watchCatalog(): void {
    if (unwatchCatalog) return;
    let statuses = statusesOf();
    unwatchCatalog = useCatalog.subscribe(() => {
      const before = statuses;
      statuses = statusesOf();
      for (const [clusterId, was] of before) {
        if (was !== "connected" || statuses.get(clusterId) === "connected") {
          continue;
        }
        releaseSeq.set(clusterId, (releaseSeq.get(clusterId) ?? 0) + 1);
        releaseLoads.delete(clusterId);
        set((s) => {
          const releases = { ...s.releases };
          delete releases[clusterId];
          const runs = Object.fromEntries(
            Object.entries(s.runs).filter(([, r]) => r.clusterId !== clusterId),
          );
          return { releases, runs };
        });
      }
    });
  }
});

export function resetHelmForTest(): void {
  subscribed = null;
  toolsLoading = null;
  reposLoading = null;
  chartsLoading = null;
  toolsSeq = 0;
  reposSeq = 0;
  chartsSeq = 0;
  downloading.clear();
  releaseSeq.clear();
  releaseLoads.clear();
  for (const watch of watchers.values()) window.clearInterval(watch.timer);
  watchers.clear();
  openPages.clear();
  stopWanted.clear();
  runSeq = 0;
  unwatchCatalog?.();
  unwatchCatalog = null;
  useHelm.setState(FIRST);
}

export const RELEASES_POLL_MS = 15_000;

export interface ReleasesSlice {
  list: HelmReleaseList | null;
  error: IpcFailure | null;
  loading: boolean;
  /** What the list was asked for; null is every namespace. */
  namespaces: string[] | null;
}

export type RunKind = "install" | "upgrade" | "rollback" | "uninstall";
export type RunPhase = "running" | "succeeded" | "failed" | "stopped";

interface RunBase {
  kind: RunKind;
  clusterId: string;
  namespace: string;
  release: string;
  /** The rollback's target revision. */
  revision: number | null;
  /** The uninstall's --keep-history. */
  keepHistory: boolean;
}

export interface HelmRun extends RunBase {
  key: string;
  /** Tells a run from the one it replaced under the same key. */
  id: number;
  /** Null until the start call answers. */
  sessionId: string | null;
  phase: RunPhase;
  output: string;
  error: { message: string; details: string | null } | null;
  /** The start call itself was refused, so helm wrote nothing. */
  rejected: boolean;
}

export function runKey(
  clusterId: string,
  namespace: string,
  release: string,
): string {
  return `${clusterId}/${namespace}/${release}`;
}

/** Busy releases hide Upgrade, Roll back and Uninstall (spec §5.3). */
export function releaseIsBusy(
  release: Pick<HelmRelease, "status">,
  run: HelmRun | undefined,
): boolean {
  return (
    release.status.startsWith("pending-") ||
    release.status === "uninstalling" ||
    run?.phase === "running"
  );
}

function statusesOf(): Map<string, string> {
  return new Map(
    useCatalog.getState().clusters.map((c) => [c.id, c.state.status] as const),
  );
}

function announceStart(run: RunBase): void {
  if (run.kind === "rollback") {
    toast.info(`Rolling back ${run.release} to revision ${run.revision}`);
  } else if (run.kind === "uninstall") {
    toast.info(`Uninstalling ${run.release}`);
  }
}

const ENDED: Record<RunKind, { done: string; failed: string }> = {
  install: { done: "Installed", failed: "Could not install" },
  upgrade: { done: "Upgraded", failed: "Could not upgrade" },
  rollback: { done: "Rolled back", failed: "Could not roll back" },
  uninstall: { done: "Uninstalled", failed: "Could not uninstall" },
};

function announceEnd(run: HelmRun): void {
  const paged = run.kind === "install" || run.kind === "upgrade";
  if (paged && openPages.has(run.key)) return;
  if (run.phase === "stopped") return;
  const words = ENDED[run.kind];
  if (run.phase === "failed") {
    toast.error(`${words.failed} ${run.release}`, run.error?.message);
    return;
  }
  if (run.kind === "rollback") {
    toast.success(`Rolled back ${run.release} to revision ${run.revision}`);
  } else if (run.kind === "uninstall" && run.keepHistory) {
    toast.success(
      `Uninstalled ${run.release}`,
      "The history stays, so it remains in Releases as uninstalled",
    );
  } else {
    toast.success(`${words.done} ${run.release}`);
  }
}
