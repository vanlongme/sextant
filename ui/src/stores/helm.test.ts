import { beforeEach, expect, test, vi } from "vitest";
import { toast } from "../design";
import { IpcFailure } from "../ipc/client";
import type { ToolStatus } from "../ipc/generated/ToolStatus";
import { chart, HELM_MISSING, toolStatus } from "../test/helm";
import { emitEvent, flush, mockBackend } from "../test/ipc";
import {
  isChecksumFailure,
  isToolMissing,
  resetHelmForTest,
  useHelm,
} from "./helm";

beforeEach(() => {
  resetHelmForTest();
  vi.restoreAllMocks();
});

const helm = () => useHelm.getState();
const SEARCH = { charts: [chart({ name: "nginx" })], repoProblems: [] };

test("ensureTools subscribes once and reads the status once", async () => {
  const backend = mockBackend({
    tools_status: () => [toolStatus({ tool: "helm" })],
  });
  await helm().ensureTools();
  await helm().ensureTools();
  expect(backend.callsTo("tools_status")).toHaveLength(1);
  expect(helm().tools.status).toEqual([toolStatus({ tool: "helm" })]);
});

test("a progress event is kept per tool, and done or failed reads the status again", async () => {
  const backend = mockBackend({
    tools_status: () => [toolStatus({ tool: "helm" })],
  });
  await helm().ensureTools();
  const progress = {
    tool: "helm",
    phase: "downloading",
    receivedBytes: 10,
    totalBytes: 100,
    error: null,
  };
  await emitEvent("tools://progress", progress);
  expect(helm().tools.progress.helm).toEqual(progress);
  expect(backend.callsTo("tools_status")).toHaveLength(1);
  await emitEvent("tools://progress", { ...progress, phase: "done" });
  expect(backend.callsTo("tools_status")).toHaveLength(2);
});

test("a download shows progress at once, then toasts where the copy is", async () => {
  const success = vi.spyOn(toast, "success");
  let finish: (status: ToolStatus) => void = () => {};
  const backend = mockBackend({
    tools_status: () => [toolStatus({ tool: "helm" })],
    tools_download: () =>
      new Promise<ToolStatus>((resolve) => {
        finish = resolve;
      }),
  });
  const running = helm().downloadTool("helm");
  await flush();
  expect(helm().tools.progress.helm).toMatchObject({
    phase: "downloading",
    receivedBytes: 0,
  });
  // A second click while it runs does not start another download.
  await helm().downloadTool("helm");
  expect(backend.callsTo("tools_download")).toEqual([{ tool: "helm" }]);

  finish(
    toolStatus({
      tool: "helm",
      source: "managed",
      path: "/data/tools/helm/v4.3.1/helm",
    }),
  );
  await running;
  expect(success).toHaveBeenCalledWith(
    "helm v4.3.1 is ready",
    "Checksum verified · /data/tools/helm/v4.3.1/helm",
  );
  expect(helm().tools.progress.helm?.phase).toBe("done");
  expect(backend.callsTo("tools_status")).toHaveLength(1);
});

test("a refused download is kept as failed with its error", async () => {
  mockBackend({
    tools_status: () => [toolStatus({ tool: "helm" })],
    tools_download: () => {
      throw {
        code: "Internal",
        message:
          "the downloaded file does not match its pinned SHA-256 checksum",
        details: null,
      };
    },
  });
  await helm().downloadTool("helm");
  const progress = helm().tools.progress.helm;
  expect(progress?.phase).toBe("failed");
  expect(isChecksumFailure(progress)).toBe(true);
});

test("a failed cancel toasts", async () => {
  const error = vi.spyOn(toast, "error");
  mockBackend({
    tools_download_cancel: () => {
      throw { code: "Internal", message: "gone", details: null };
    },
  });
  await helm().cancelDownload("helm");
  expect(error).toHaveBeenCalledWith("Could not cancel the download", "gone");
});

test("a ToolMissing failure is kept as an IpcFailure the screens can tell apart", async () => {
  mockBackend({
    helm_chart_search: () => {
      throw HELM_MISSING;
    },
  });
  await helm().ensureCharts();
  const { error } = helm().charts;
  expect(error).toBeInstanceOf(IpcFailure);
  expect(isToolMissing(error)).toBe(true);
  // ensureCharts does not retry a failed read; loadCharts does.
  await helm().ensureCharts();
  expect(helm().charts.error).not.toBeNull();
});

test("an older chart read that answers last is dropped", async () => {
  const answers: ((value: unknown) => void)[] = [];
  mockBackend({
    helm_chart_search: () =>
      new Promise((resolve) => {
        answers.push(resolve);
      }),
  });
  const first = helm().loadCharts();
  const second = helm().loadCharts();
  await flush();
  answers[1]?.(SEARCH);
  answers[0]?.({ charts: [], repoProblems: [] });
  await Promise.all([first, second]);
  expect(helm().charts.search).toEqual(SEARCH);
  expect(helm().charts.loading).toBe(false);
});

test("adding a repository reloads both lists and counts its charts", async () => {
  const success = vi.spyOn(toast, "success");
  const backend = mockBackend({
    helm_repo_add: () => null,
    helm_repo_list: () => [{ name: "bitnami", url: "https://example.test" }],
    helm_chart_search: () => ({
      charts: [
        chart({ name: "nginx" }),
        chart({ name: "redis", repo: "other" }),
      ],
      repoProblems: [],
    }),
  });
  await helm().addRepo({
    name: "bitnami",
    url: "https://example.test",
    username: null,
    password: null,
  });
  expect(backend.callsTo("helm_repo_list")).toHaveLength(1);
  expect(backend.callsTo("helm_chart_search")).toHaveLength(1);
  expect(success).toHaveBeenCalledWith(
    '"bitnami" has been added to your repositories',
    "1 chart in its index",
  );
});

test("a refused repository add rejects with its failure and changes nothing", async () => {
  mockBackend({
    helm_repo_add: () => {
      throw { code: "Conflict", message: "already exists", details: null };
    },
  });
  const adding = helm().addRepo({
    name: "bitnami",
    url: "https://example.test",
    username: null,
    password: null,
  });
  await expect(adding).rejects.toMatchObject({ code: "Conflict" });
  expect(helm().repos.list).toBeNull();
});

test("a failed remove toasts and gives false", async () => {
  const error = vi.spyOn(toast, "error");
  mockBackend({
    helm_repo_remove: () => {
      throw { code: "Internal", message: "locked", details: null };
    },
  });
  expect(await helm().removeRepo("bitnami")).toBe(false);
  expect(error).toHaveBeenCalledWith("Could not remove bitnami", "locked");
});

test("updating marks the repositories, toasts at both ends and reloads the charts", async () => {
  const info = vi.spyOn(toast, "info");
  const success = vi.spyOn(toast, "success");
  let finish: () => void = () => {};
  const backend = mockBackend({
    helm_repo_list: () => [
      { name: "a", url: "https://a.test" },
      { name: "b", url: "https://b.test" },
    ],
    helm_repo_update: () =>
      new Promise<null>((resolve) => {
        finish = () => resolve(null);
      }),
    helm_chart_search: () => SEARCH,
  });
  await helm().ensureRepos();
  const updating = helm().updateRepos(null);
  await flush();
  expect(helm().repos.updating).toEqual(["a", "b"]);
  expect(info).toHaveBeenCalledWith("Updating 2 repositories", "a, b");
  expect(backend.callsTo("helm_repo_update")).toEqual([{ names: null }]);
  finish();
  await updating;
  expect(helm().repos.updating).toEqual([]);
  expect(success).toHaveBeenCalledWith("Updated 2 repositories");
  expect(helm().charts.search).toEqual(SEARCH);
});

test("updating one repository names it", async () => {
  const info = vi.spyOn(toast, "info");
  const success = vi.spyOn(toast, "success");
  mockBackend({
    helm_repo_update: () => null,
    helm_chart_search: () => SEARCH,
  });
  await helm().updateRepos(["a"]);
  expect(info).toHaveBeenCalledWith("Updating 1 repository", "a");
  expect(success).toHaveBeenCalledWith("Updated a");
});

test("a finished helm download reloads repos and charts stuck on ToolMissing", async () => {
  let installed = false;
  mockBackend({
    tools_status: () => [
      toolStatus({
        tool: "helm",
        source: installed ? "managed" : "missing",
      }),
    ],
    helm_chart_search: () => {
      if (!installed) throw HELM_MISSING;
      return { charts: [], errors: [] };
    },
    helm_repo_list: () => {
      if (!installed) throw HELM_MISSING;
      return [];
    },
  });
  await helm().loadTools();
  await helm().loadRepos();
  await helm().ensureCharts();
  expect(isToolMissing(helm().charts.error)).toBe(true);
  expect(isToolMissing(helm().repos.error)).toBe(true);
  installed = true;
  await helm().loadTools();
  await flush();
  expect(helm().charts.error).toBeNull();
  expect(helm().charts.search).not.toBeNull();
  expect(helm().repos.error).toBeNull();
  expect(helm().repos.list).toEqual([]);
});
