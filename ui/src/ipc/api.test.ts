import { Channel } from "@tauri-apps/api/core";
import { expect, test } from "vitest";
import { mockBackend } from "../test/ipc";
import { api } from "./api";
import type { HelmInstallRequest } from "./generated/HelmInstallRequest";
import type { HelmRepoAdd } from "./generated/HelmRepoAdd";
import type { HelmUpgradeRequest } from "./generated/HelmUpgradeRequest";
import type { PortForwardSpec } from "./generated/PortForwardSpec";
import type { SessionEvent } from "./generated/SessionEvent";

const SIZE = { cols: 120, rows: 32 };
const noop = () => {};

test.each<[string, () => Promise<string>, Record<string, unknown>]>([
  [
    "terminal_start",
    () => api.terminalStart("c1", SIZE, noop, noop),
    { clusterId: "c1", size: SIZE },
  ],
  [
    "pod_exec_start",
    () => api.podExecStart("c1", "shop", "web-1", "app", SIZE, noop, noop),
    {
      clusterId: "c1",
      namespace: "shop",
      pod: "web-1",
      container: "app",
      size: SIZE,
    },
  ],
  [
    "pod_attach_start",
    () => api.podAttachStart("c1", "shop", "web-1", null, SIZE, noop, noop),
    {
      clusterId: "c1",
      namespace: "shop",
      pod: "web-1",
      container: null,
      size: SIZE,
    },
  ],
  [
    "node_shell_start",
    () => api.nodeShellStart("c1", "worker-1", SIZE, noop, noop),
    { clusterId: "c1", node: "worker-1", size: SIZE },
  ],
])(
  "%s gets its target, the size and two channels, and gives the session id",
  async (cmd, start, args) => {
    const backend = mockBackend({ [cmd]: () => "s1" });
    await expect(start()).resolves.toBe("s1");
    const sent = backend.callsTo(cmd)[0];
    expect(sent).toMatchObject(args);
    expect(sent?.onData).toBeInstanceOf(Channel);
    expect(sent?.onEvent).toBeInstanceOf(Channel);
  },
);

test("the output channel hands each chunk to onData as it came", async () => {
  const chunks: ArrayBuffer[] = [];
  const backend = mockBackend({ terminal_start: () => "s1" });
  await api.terminalStart("c1", SIZE, (chunk) => chunks.push(chunk), noop);
  const onData = backend.callsTo("terminal_start")[0]
    ?.onData as Channel<ArrayBuffer>;
  onData.onmessage(new Uint8Array([104, 105]).buffer);
  expect(Array.from(new Uint8Array(chunks[0] as ArrayBuffer))).toEqual([
    104, 105,
  ]);
});

test("write, resize and stop name the session", async () => {
  const backend = mockBackend({
    session_write: () => null,
    session_resize: () => null,
    session_stop: () => null,
  });
  await api.sessionWrite("s1", [108, 115, 13]);
  await api.sessionResize("s1", SIZE);
  await api.sessionStop("s1");
  expect(backend.calls.map((c) => [c.cmd, c.args])).toEqual([
    ["session_write", { sessionId: "s1", data: [108, 115, 13] }],
    ["session_resize", { sessionId: "s1", size: SIZE }],
    ["session_stop", { sessionId: "s1" }],
  ]);
});

const SPEC: PortForwardSpec = {
  clusterId: "c1",
  target: { kind: "service", namespace: "shop", name: "web" },
  targetPort: 80,
  localPort: null,
};

test.each<[string, () => Promise<unknown>, Record<string, unknown>]>([
  ["resources_names", () => api.resourcesNames("c1"), { clusterId: "c1" }],
  ["portforward_list", () => api.portforwardList(), {}],
  ["portforward_add", () => api.portforwardAdd(SPEC), { spec: SPEC }],
  ["portforward_start", () => api.portforwardStart("pf-1"), { id: "pf-1" }],
  ["portforward_stop", () => api.portforwardStop("pf-1"), { id: "pf-1" }],
  ["portforward_remove", () => api.portforwardRemove("pf-1"), { id: "pf-1" }],
  ["app_info", () => api.appInfo(), {}],
  [
    "open_external",
    () => api.openExternal("http://127.0.0.1:50123/"),
    { url: "http://127.0.0.1:50123/" },
  ],
])("%s gets exactly its arguments", async (cmd, run, args) => {
  const backend = mockBackend({ [cmd]: () => null });
  await run();
  expect(backend.calls).toEqual([{ cmd, args }]);
});

const INSTALL: HelmInstallRequest = {
  namespace: "shop",
  releaseName: "web",
  chart: { repo: "bitnami", chart: "nginx", version: "1.2.3" },
  values: "replicaCount: 2\n",
  createNamespace: true,
  wait: true,
};
const UPGRADE: HelmUpgradeRequest = {
  namespace: "shop",
  release: "web",
  chart: { repo: "bitnami", chart: "nginx", version: "1.2.4" },
  values: "",
  wait: true,
};

test.each<[string, () => Promise<string>, Record<string, unknown>]>([
  [
    "helm_install_start",
    () => api.helmInstallStart("c1", INSTALL, noop, noop),
    { clusterId: "c1", request: INSTALL },
  ],
  [
    "helm_upgrade_start",
    () => api.helmUpgradeStart("c1", UPGRADE, noop, noop),
    { clusterId: "c1", request: UPGRADE },
  ],
  [
    "helm_rollback_start",
    () => api.helmRollbackStart("c1", "shop", "web", 2, true, noop, noop),
    {
      clusterId: "c1",
      namespace: "shop",
      release: "web",
      revision: 2,
      wait: true,
    },
  ],
  [
    "helm_uninstall_start",
    () => api.helmUninstallStart("c1", "shop", "web", true, true, noop, noop),
    {
      clusterId: "c1",
      namespace: "shop",
      release: "web",
      wait: true,
      keepHistory: true,
    },
  ],
])(
  "%s gets its arguments and two channels, and gives the session id",
  async (cmd, start, args) => {
    const backend = mockBackend({ [cmd]: () => "s1" });
    await expect(start()).resolves.toBe("s1");
    const sent = backend.callsTo(cmd)[0] ?? {};
    const { onData, onEvent, ...rest } = sent;
    expect(rest).toEqual(args);
    expect(onData).toBeInstanceOf(Channel);
    expect(onEvent).toBeInstanceOf(Channel);
  },
);

test("a helm run's channels hand its output and its events over", async () => {
  const chunks: ArrayBuffer[] = [];
  const seen: SessionEvent[] = [];
  const backend = mockBackend({ helm_upgrade_start: () => "s1" });
  await api.helmUpgradeStart(
    "c1",
    UPGRADE,
    (chunk) => chunks.push(chunk),
    (event) => seen.push(event),
  );
  const sent = backend.callsTo("helm_upgrade_start")[0] ?? {};
  const onData = sent.onData as Channel<ArrayBuffer>;
  const onEvent = sent.onEvent as Channel<SessionEvent>;
  onData.onmessage(new Uint8Array([111, 107]).buffer);
  onEvent.onmessage({ type: "exited", code: 0 });
  expect(Array.from(new Uint8Array(chunks[0] as ArrayBuffer))).toEqual([
    111, 107,
  ]);
  expect(seen).toEqual([{ type: "exited", code: 0 }]);
});

const ADD: HelmRepoAdd = {
  name: "bitnami",
  url: "https://charts.example/stable",
  username: null,
  password: null,
};

test.each<[string, () => Promise<unknown>, Record<string, unknown>]>([
  ["tools_status", () => api.toolsStatus(), {}],
  ["tools_download", () => api.toolsDownload("kubectl"), { tool: "kubectl" }],
  [
    "tools_download_cancel",
    () => api.toolsDownloadCancel("helm"),
    { tool: "helm" },
  ],
  ["helm_version", () => api.helmVersion(), {}],
  ["helm_repo_list", () => api.helmRepoList(), {}],
  ["helm_repo_add", () => api.helmRepoAdd(ADD), { repo: ADD }],
  [
    "helm_repo_remove",
    () => api.helmRepoRemove("bitnami"),
    { name: "bitnami" },
  ],
  [
    "helm_repo_update",
    () => api.helmRepoUpdate(["bitnami"]),
    { names: ["bitnami"] },
  ],
  ["helm_repo_update", () => api.helmRepoUpdate(null), { names: null }],
  [
    "helm_chart_search",
    () => api.helmChartSearch("", null),
    { query: "", limit: null },
  ],
  [
    "helm_chart_versions",
    () => api.helmChartVersions("bitnami", "nginx"),
    { repo: "bitnami", chart: "nginx" },
  ],
  [
    "helm_chart_readme",
    () => api.helmChartReadme("bitnami", "nginx", "1.2.3"),
    { repo: "bitnami", chart: "nginx", version: "1.2.3" },
  ],
  [
    "helm_chart_values",
    () => api.helmChartValues("bitnami", "nginx", "1.2.3"),
    { repo: "bitnami", chart: "nginx", version: "1.2.3" },
  ],
  [
    "helm_release_list",
    () => api.helmReleaseList("c1", ["shop", "team-a"]),
    { clusterId: "c1", namespaces: ["shop", "team-a"] },
  ],
  [
    "helm_release_list",
    () => api.helmReleaseList("c1", null),
    { clusterId: "c1", namespaces: null },
  ],
  [
    "helm_release_get",
    () => api.helmReleaseGet("c1", "shop", "web"),
    { clusterId: "c1", namespace: "shop", name: "web" },
  ],
  [
    "helm_release_values",
    () => api.helmReleaseValues("c1", "shop", "web", true),
    { clusterId: "c1", namespace: "shop", name: "web", all: true },
  ],
  [
    "helm_release_history",
    () => api.helmReleaseHistory("c1", "shop", "web"),
    { clusterId: "c1", namespace: "shop", name: "web" },
  ],
  [
    "helm_install_preview",
    () => api.helmInstallPreview("c1", INSTALL),
    { clusterId: "c1", request: INSTALL },
  ],
  [
    "helm_upgrade_preview",
    () => api.helmUpgradePreview("c1", UPGRADE),
    { clusterId: "c1", request: UPGRADE },
  ],
])("%s gets exactly its arguments", async (cmd, run, args) => {
  const backend = mockBackend({ [cmd]: () => null });
  await run();
  expect(backend.calls).toEqual([{ cmd, args }]);
});
