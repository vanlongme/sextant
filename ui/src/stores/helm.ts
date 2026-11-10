import { create } from "zustand";
import { toast } from "../design";
import { api } from "../ipc/api";
import { IpcFailure } from "../ipc/client";
import { events } from "../ipc/events";
import type { ChartSearch } from "../ipc/generated/ChartSearch";
import type { HelmRepo } from "../ipc/generated/HelmRepo";
import type { HelmRepoAdd } from "../ipc/generated/HelmRepoAdd";
import type { ToolName } from "../ipc/generated/ToolName";
import type { ToolProgress } from "../ipc/generated/ToolProgress";
import type { ToolStatus } from "../ipc/generated/ToolStatus";

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
  };
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
  useHelm.setState(FIRST);
}
