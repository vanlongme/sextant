import { beforeEach, expect, test, vi } from "vitest";
import { toast } from "../design";
import { openTerminal } from "../features/dock/openTerminal";
import type { ClusterInfo } from "../ipc/generated/ClusterInfo";
import type { ConnectionState } from "../ipc/generated/ConnectionState";
import { resetPrefsForTest } from "../stores/prefs";
import { resetShellForTest, useShell } from "../stores/shell";
import { resetWorkspaceForTest, useWorkspace } from "../stores/workspace";
import { mockBackend } from "../test/ipc";
import {
  COMMANDS,
  type CommandContext,
  runCommand,
  runMenuCommand,
} from "./commands";

vi.mock("../features/dock/openTerminal", () => ({ openTerminal: vi.fn() }));

const INFO: ClusterInfo = {
  version: "v1.31.0",
  distribution: "kind",
  nodeCount: 1,
  namespaces: ["default"],
  namespacesRestricted: false,
  isAdmin: true,
};
const CONNECTED: ConnectionState = { status: "connected", info: INFO };

function context(over: Partial<Omit<CommandContext, "navigate">> = {}) {
  const navigate = vi.fn<(to: string | number) => void>();
  return { navigate, pathname: "/catalog", cluster: null, ...over };
}

function on(state: ConnectionState) {
  return { id: "c1", name: "prod", state };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  resetShellForTest();
  resetPrefsForTest();
});

test("the registry lists the spec's commands in order", () => {
  const ctx = context({ cluster: on(CONNECTED) });
  expect(COMMANDS.map((c) => [c.id, c.label(ctx), c.shortcut ?? null])).toEqual(
    [
      ["catalog", "Go to the catalog", null],
      ["preferences", "Open Preferences", "preferences"],
      ["add-cluster", "Add a cluster", null],
      ["install-chart", "Install a Helm chart", null],
      ["terminal", "Open a terminal in prod", "terminal"],
      ["disconnect", "Disconnect prod", null],
      ["cluster-settings", "Cluster settings for prod", null],
      ["resource-map", "Resource map of prod", null],
      ["shortcuts", "Show keyboard shortcuts", "shortcuts"],
      ["about", "About SkoposIDE", null],
      ["theme-dark", "Theme: Dark", null],
      ["theme-light", "Theme: Light", null],
      ["theme-system", "Theme: System", null],
      ["back", "Go back", "back"],
      ["forward", "Go forward", "forward"],
      ["workspace", "Workspace", null],
      ["workspace-open", "Open prod in the Workspace", null],
    ],
  );
});

test("terminal, disconnect, install-chart and resource-map need the current cluster connected; cluster-settings and workspace-open any cluster", () => {
  const available = (ctx: CommandContext) =>
    COMMANDS.filter((c) => c.available(ctx)).map((c) => c.id);
  const all = COMMANDS.map((c) => c.id);
  const onCluster = all.filter(
    (id) =>
      id !== "terminal" &&
      id !== "disconnect" &&
      id !== "install-chart" &&
      id !== "resource-map",
  );
  const always = onCluster.filter(
    (id) => id !== "cluster-settings" && id !== "workspace-open",
  );
  expect(available(context())).toEqual(always);
  expect(
    available(context({ cluster: on({ status: "disconnected" }) })),
  ).toEqual(onCluster);
  expect(available(context({ cluster: on({ status: "connecting" }) }))).toEqual(
    onCluster,
  );
  expect(available(context({ cluster: on(CONNECTED) }))).toEqual(all);
});

test("resource-map opens the cluster's map", () => {
  const ctx = context({ cluster: on(CONNECTED) });
  runCommand("resource-map", ctx);
  expect(ctx.navigate.mock.calls).toEqual([["/cluster/c1/map"]]);
});

test("install-chart opens the cluster's Charts", () => {
  const ctx = context({ cluster: on(CONNECTED) });
  runCommand("install-chart", ctx);
  expect(ctx.navigate.mock.calls).toEqual([["/cluster/c1/helm/charts"]]);
});

test("cluster-settings opens the cluster's Settings page, connected or not, once", () => {
  const off = context({
    pathname: "/cluster/a%2Fb",
    cluster: { id: "a/b", name: "staging", state: { status: "disconnected" } },
  });
  runCommand("cluster-settings", off);
  expect(off.navigate.mock.calls).toEqual([["/cluster/a%2Fb/settings"]]);

  const there = context({
    pathname: "/cluster/c1/settings",
    cluster: on(CONNECTED),
  });
  runCommand("cluster-settings", there);
  expect(there.navigate).not.toHaveBeenCalled();

  const nowhere = context();
  runCommand("cluster-settings", nowhere);
  expect(nowhere.navigate).not.toHaveBeenCalled();
});

test("catalog, back and forward navigate", () => {
  const ctx = context({ pathname: "/preferences" });
  runCommand("catalog", ctx);
  runCommand("back", ctx);
  runCommand("forward", ctx);
  expect(ctx.navigate.mock.calls).toEqual([["/catalog"], [-1], [1]]);
});

test("workspace goes to the Workspace, once", () => {
  const ctx = context({ cluster: on(CONNECTED) });
  runCommand("workspace", ctx);
  expect(ctx.navigate.mock.calls).toEqual([["/workspace"]]);

  const there = context({ pathname: "/workspace" });
  runCommand("workspace", there);
  expect(there.navigate).not.toHaveBeenCalled();
});

test("workspace-open opens the current cluster in the Workspace and goes there", async () => {
  resetWorkspaceForTest();
  mockBackend({ ui_state_get: () => null, ui_state_set: () => null });
  const ctx = context({ pathname: "/cluster/c1", cluster: on(CONNECTED) });

  runCommand("workspace-open", ctx);

  expect(ctx.navigate.mock.calls).toEqual([["/workspace"]]);
  await vi.waitFor(() =>
    expect(useWorkspace.getState().layout.panes[0].tabs).toEqual([
      { id: "t2", clusterId: "c1", view: "pods", pinned: false },
    ]),
  );

  const nowhere = context();
  runCommand("workspace-open", nowhere);
  expect(nowhere.navigate).not.toHaveBeenCalled();
});

test("preferences closes a shell dialog and does not navigate where it is", () => {
  useShell.getState().open("palette");
  const ctx = context();
  runCommand("preferences", ctx);
  expect(useShell.getState().dialog).toBeNull();
  expect(ctx.navigate).toHaveBeenCalledWith("/preferences");

  const there = context({ pathname: "/preferences" });
  runCommand("preferences", there);
  expect(there.navigate).not.toHaveBeenCalled();
});

test("add a cluster goes to the catalog and opens the dialog", () => {
  const ctx = context({ pathname: "/cluster/c1" });
  runCommand("add-cluster", ctx);
  expect(ctx.navigate).toHaveBeenCalledWith("/catalog");
  expect(useShell.getState().addClusterOpen).toBe(true);
});

test("shortcuts and about open their dialogs", () => {
  runCommand("shortcuts", context());
  expect(useShell.getState().dialog).toBe("shortcuts");
  runCommand("about", context());
  expect(useShell.getState().dialog).toBe("about");
});

test("terminal opens the cluster's terminal, and only when it may", () => {
  runCommand("terminal", context({ cluster: on({ status: "disconnected" }) }));
  expect(openTerminal).not.toHaveBeenCalled();
  runCommand("terminal", context({ cluster: on(CONNECTED) }));
  expect(openTerminal).toHaveBeenCalledWith("c1");
});

test("disconnect calls the backend and toasts a failure", async () => {
  const ipc = mockBackend({
    cluster_disconnect: () => {
      throw { code: "Internal", message: "boom", details: null };
    },
  });
  const failed = vi.spyOn(toast, "error");
  runCommand("disconnect", context({ cluster: on(CONNECTED) }));
  await vi.waitFor(() =>
    expect(failed).toHaveBeenCalledWith("Could not disconnect", "boom"),
  );
  expect(ipc.callsTo("cluster_disconnect")).toEqual([{ id: "c1" }]);
});

test("a theme command saves the theme, loading the preferences first if needed", async () => {
  const ipc = mockBackend({
    prefs_get: () => ({ theme: "system", syncSources: [] }),
    prefs_set: () => null,
  });
  runCommand("theme-dark", context());
  await vi.waitFor(() =>
    expect(ipc.callsTo("prefs_set")).toEqual([
      { prefs: { theme: "dark", syncSources: [] } },
    ]),
  );
  expect(ipc.callsTo("prefs_get")).toHaveLength(1);
});

test("menu ids run their commands and others are ignored", () => {
  const ctx = context();
  runMenuCommand("palette", ctx);
  expect(useShell.getState().dialog).toBe("palette");
  runMenuCommand("shortcuts", ctx);
  expect(useShell.getState().dialog).toBe("shortcuts");
  runMenuCommand("about", ctx);
  expect(useShell.getState().dialog).toBe("about");
  runMenuCommand("preferences", ctx);
  expect(useShell.getState().dialog).toBeNull();
  runMenuCommand("quit", ctx);
  expect(ctx.navigate.mock.calls).toEqual([["/preferences"]]);
});

test("menu ids do nothing while another modal dialog is open", () => {
  const ctx = context();
  const scale = document.createElement("div");
  scale.setAttribute("role", "dialog");
  document.body.append(scale);
  try {
    for (const id of ["palette", "shortcuts", "about", "preferences"]) {
      runMenuCommand(id, ctx);
    }
    expect(useShell.getState().dialog).toBeNull();
    expect(ctx.navigate).not.toHaveBeenCalled();
  } finally {
    scale.remove();
  }
});

test("an open shell dialog does not stop menu ids", () => {
  const ctx = context();
  const palette = document.createElement("div");
  palette.setAttribute("role", "dialog");
  palette.setAttribute("data-shell-dialog", "");
  document.body.append(palette);
  try {
    runMenuCommand("about", ctx);
    expect(useShell.getState().dialog).toBe("about");
  } finally {
    palette.remove();
  }
});
