import type { Channel } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { toast } from "../design";
import type { HelmReleaseList } from "../ipc/generated/HelmReleaseList";
import type { SessionEvent } from "../ipc/generated/SessionEvent";
import { release, releaseList, runHandlers } from "../test/helm";
import { flush, mockBackend } from "../test/ipc";
import { connectClusters, setClusterState } from "../test/terminal";
import { resetCatalogForTest } from "./catalog";
import {
  RELEASES_POLL_MS,
  releaseIsBusy,
  resetHelmForTest,
  runKey,
  useHelm,
} from "./helm";

beforeEach(() => {
  resetHelmForTest();
  resetCatalogForTest();
  connectClusters({ id: "c1", name: "kind" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const helm = () => useHelm.getState();
const KEY = runKey("c1", "shop", "web");
const LIST = releaseList([release({ name: "web" })]);

test("watching loads at once, every 15 s while visible, and stops with the last watcher", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const backend = mockBackend({ helm_release_list: () => LIST });
  const stopA = helm().watchReleases("c1", null);
  const stopB = helm().watchReleases("c1", null);
  await flush();
  expect(backend.callsTo("helm_release_list")).toEqual([
    { clusterId: "c1", namespaces: null },
  ]);
  expect(helm().releases.c1?.list).toEqual(LIST);

  vi.advanceTimersByTime(RELEASES_POLL_MS);
  await flush();
  expect(backend.callsTo("helm_release_list")).toHaveLength(2);

  const hidden = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("hidden");
  vi.advanceTimersByTime(RELEASES_POLL_MS);
  await flush();
  expect(backend.callsTo("helm_release_list")).toHaveLength(2);
  hidden.mockRestore();

  stopA();
  stopA();
  vi.advanceTimersByTime(RELEASES_POLL_MS);
  await flush();
  expect(backend.callsTo("helm_release_list")).toHaveLength(3);
  stopB();
  vi.advanceTimersByTime(RELEASES_POLL_MS);
  await flush();
  expect(backend.callsTo("helm_release_list")).toHaveLength(3);
});

test("the same namespaces share one read; new namespaces clear the list and win", async () => {
  const answers: ((list: HelmReleaseList) => void)[] = [];
  const backend = mockBackend({
    helm_release_list: () =>
      new Promise<HelmReleaseList>((resolve) => {
        answers.push(resolve);
      }),
  });
  const first = helm().loadReleases("c1", ["shop"]);
  const again = helm().loadReleases("c1", ["shop"]);
  await flush();
  expect(backend.callsTo("helm_release_list")).toHaveLength(1);
  answers[0]?.(LIST);
  await Promise.all([first, again]);
  expect(helm().releases.c1).toMatchObject({
    list: LIST,
    namespaces: ["shop"],
  });

  const other = releaseList([release({ name: "db", namespace: "data" })]);
  const older = helm().loadReleases("c1");
  const newer = helm().loadReleases("c1", ["data"]);
  await flush();
  expect(helm().releases.c1).toMatchObject({ list: null, loading: true });
  answers[2]?.(other);
  answers[1]?.(LIST);
  await Promise.all([older, newer]);
  expect(helm().releases.c1).toMatchObject({
    list: other,
    namespaces: ["data"],
    loading: false,
  });
});

test("a run streams decoded output, succeeds on exit 0 and reloads the releases", async () => {
  const { started, handlers } = runHandlers();
  const backend = mockBackend({
    ...handlers,
    helm_release_list: () => LIST,
  });
  await helm().loadReleases("c1", null);
  await helm().startUpgrade("c1", {
    namespace: "shop",
    release: "web",
    chart: { repo: "bitnami", chart: "nginx", version: "1.2.4" },
    values: "",
    wait: true,
  });
  expect(helm().runs[KEY]).toMatchObject({
    kind: "upgrade",
    phase: "running",
    sessionId: "session-1",
  });
  const run = started[0];
  if (!run) throw new Error("no run started");
  // "é" split across two chunks still decodes as one character.
  const bytes = new TextEncoder().encode("café\n");
  const onData = run.args.onData as Channel<ArrayBuffer>;
  onData.onmessage(bytes.slice(0, 4).buffer);
  onData.onmessage(bytes.slice(4).buffer);
  expect(helm().runs[KEY]?.output).toBe("café\n");

  run.send({ type: "exited", code: 0 });
  await flush();
  expect(helm().runs[KEY]).toMatchObject({ phase: "succeeded", error: null });
  expect(backend.callsTo("helm_release_list")).toHaveLength(2);
});

test.each<[string, SessionEvent, object]>([
  [
    "another exit code fails",
    { type: "exited", code: 2 },
    {
      phase: "failed",
      error: { message: "helm exited with code 2", details: null },
    },
  ],
  [
    "no exit code fails",
    { type: "exited", code: null },
    {
      phase: "failed",
      error: { message: "helm exited with no exit code", details: null },
    },
  ],
  [
    "Cancelled stops",
    {
      type: "failed",
      error: { code: "Cancelled", message: "stopped", details: null },
      podEvents: [],
    },
    { phase: "stopped", error: null },
  ],
  [
    "another failure fails with its message and details",
    {
      type: "failed",
      error: {
        code: "Internal",
        message: "UPGRADE FAILED: timed out",
        details: "context deadline exceeded",
      },
      podEvents: [],
    },
    {
      phase: "failed",
      error: {
        message: "UPGRADE FAILED: timed out",
        details: "context deadline exceeded",
      },
    },
  ],
])("%s", async (_name, event, expected) => {
  const { started, handlers } = runHandlers();
  mockBackend(handlers);
  await helm().startRollback("c1", "shop", "web", 2);
  started[0]?.send(event);
  // A run ends once: a later event changes nothing.
  started[0]?.send({ type: "exited", code: 0 });
  expect(helm().runs[KEY]).toMatchObject({ ...expected, rejected: false });
});

test("a refused start fails the run as rejected", async () => {
  mockBackend({
    helm_install_start: () => {
      throw {
        code: "InvalidInput",
        message: "values are not valid YAML",
        details: "line 2",
      };
    },
  });
  await helm().startInstall("c1", {
    namespace: "shop",
    releaseName: "web",
    chart: { repo: "bitnami", chart: "nginx", version: "1.2.3" },
    values: "a: [",
    createNamespace: false,
    wait: true,
  });
  expect(helm().runs[KEY]).toMatchObject({
    kind: "install",
    phase: "failed",
    rejected: true,
    error: { message: "values are not valid YAML", details: "line 2" },
  });
});

test("a new run replaces the last one under its key; the old one's events are ignored", async () => {
  const { started, handlers } = runHandlers();
  mockBackend(handlers);
  await helm().startRollback("c1", "shop", "web", 2);
  await helm().startUninstall("c1", "shop", "web", false);
  started[0]?.data("old output");
  started[0]?.send({ type: "exited", code: 1 });
  expect(helm().runs[KEY]).toMatchObject({
    kind: "uninstall",
    phase: "running",
    output: "",
  });
});

test("stopRun stops the session, also when asked before the session id is known", async () => {
  let answer: (id: string) => void = () => {};
  const backend = mockBackend({
    helm_rollback_start: () =>
      new Promise<string>((resolve) => {
        answer = resolve;
      }),
    session_stop: () => null,
  });
  const starting = helm().startRollback("c1", "shop", "web", 2);
  await flush();
  helm().stopRun(KEY);
  expect(backend.callsTo("session_stop")).toEqual([]);
  answer("session-9");
  await starting;
  expect(backend.callsTo("session_stop")).toEqual([{ sessionId: "session-9" }]);
  helm().stopRun(KEY);
  expect(backend.callsTo("session_stop")).toHaveLength(2);
});

test("rollback and uninstall runs toast at the start and the end", async () => {
  const info = vi.spyOn(toast, "info");
  const success = vi.spyOn(toast, "success");
  const error = vi.spyOn(toast, "error");
  const { started, handlers } = runHandlers();
  mockBackend(handlers);

  await helm().startRollback("c1", "shop", "web", 2);
  expect(info).toHaveBeenCalledWith("Rolling back web to revision 2");
  started[0]?.send({ type: "exited", code: 0 });
  expect(success).toHaveBeenCalledWith("Rolled back web to revision 2");

  await helm().startUninstall("c1", "shop", "web", true);
  expect(info).toHaveBeenCalledWith("Uninstalling web");
  started[1]?.send({ type: "exited", code: 0 });
  expect(success).toHaveBeenCalledWith(
    "Uninstalled web",
    "The history stays, so it remains in Releases as uninstalled",
  );

  await helm().startUninstall("c1", "shop", "web", false);
  started[2]?.send({
    type: "failed",
    error: { code: "Internal", message: "forbidden", details: null },
    podEvents: [],
  });
  expect(error).toHaveBeenCalledWith("Could not uninstall web", "forbidden");
});

test("an install or upgrade toasts only while its page is not open, and a stop never toasts", async () => {
  const success = vi.spyOn(toast, "success");
  const { started, handlers } = runHandlers();
  mockBackend(handlers);
  const upgrade = {
    namespace: "shop",
    release: "web",
    chart: { repo: "bitnami", chart: "nginx", version: "1.2.4" },
    values: "",
    wait: true,
  };

  const closePage = helm().showRunPage(KEY);
  await helm().startUpgrade("c1", upgrade);
  started[0]?.send({ type: "exited", code: 0 });
  expect(success).not.toHaveBeenCalled();
  closePage();

  await helm().startUpgrade("c1", upgrade);
  started[1]?.send({ type: "exited", code: 0 });
  expect(success).toHaveBeenCalledWith("Upgraded web");

  await helm().startUpgrade("c1", upgrade);
  started[2]?.send({
    type: "failed",
    error: { code: "Cancelled", message: "stopped", details: null },
    podEvents: [],
  });
  expect(success).toHaveBeenCalledTimes(1);
});

test("a cluster that leaves connected drops its runs and releases", async () => {
  const { handlers } = runHandlers();
  mockBackend({ ...handlers, helm_release_list: () => LIST });
  await helm().loadReleases("c1", null);
  await helm().startRollback("c1", "shop", "web", 2);
  setClusterState("c1", { status: "connecting" });
  expect(helm().runs).toEqual({});
  expect(helm().releases).toEqual({});
});

test.each([
  ["deployed", undefined, false],
  ["pending-upgrade", undefined, true],
  ["pending-install", undefined, true],
  ["uninstalling", undefined, true],
  ["failed", undefined, false],
  ["deployed", "running", true],
  ["deployed", "failed", false],
] as const)("status %s with a %s run is busy: %s", (status, phase, busy) => {
  const run = phase
    ? {
        key: KEY,
        id: 1,
        kind: "upgrade" as const,
        clusterId: "c1",
        namespace: "shop",
        release: "web",
        revision: null,
        keepHistory: false,
        sessionId: "s",
        phase,
        output: "",
        error: null,
        rejected: false,
      }
    : undefined;
  expect(releaseIsBusy({ status }, run)).toBe(busy);
});
