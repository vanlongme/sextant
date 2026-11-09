import { type LucideIcon, Plug, Terminal } from "lucide-react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { toast } from "../../design";
import {
  mountView,
  resetSessionsForTest,
} from "../../features/terminal/sessions";
import { setTermViewFactory } from "../../features/terminal/termView";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import type { SessionEvent } from "../../ipc/generated/SessionEvent";
import { resetCatalogForTest } from "../../stores/catalog";
import {
  nodeShellTabFor,
  resetDockForTest,
  terminalTab,
  useDock,
} from "../../stores/dock";
import { type Backend, flush, mockBackend } from "../../test/ipc";
import {
  captureResizeObservers,
  connectClusters,
  installFakeViews,
  stubFrames,
} from "../../test/terminal";
import "../nodes/index";
import type { KubeObject } from "../objects";
import { NODES, PODS } from "../refs";
import { type ActionContext, type KindAction, kindSpec } from "../registry";
import "./index";
import {
  nodeShellAction,
  podAttachAction,
  podShellAction,
} from "./sessionActions";

const WEB_1: KubeObject = {
  metadata: { name: "web-1", namespace: "shop" },
  spec: { containers: [{ name: "app" }, { name: "sidecar" }] },
  status: {
    containerStatuses: [
      { name: "app", state: { waiting: { reason: "CrashLoopBackOff" } } },
      { name: "sidecar", state: { running: {} } },
    ],
  },
};
const WORKER: KubeObject = {
  metadata: { name: "worker-1" },
  status: { nodeInfo: { operatingSystem: "linux" } },
};
const WINDOWS_NODE: KubeObject = {
  metadata: { name: "win-1" },
  status: { nodeInfo: { operatingSystem: "windows" } },
};
const NODE_SHELL = nodeShellTabFor("c1", "worker-1");

let backend: Backend;
let settings: () => unknown = () => ({ nodeShellImage: null });
let sendNodeEvent: (event: SessionEvent) => void = () => {};

beforeEach(() => {
  installFakeViews();
  stubFrames();
  captureResizeObservers();
  connectClusters({ id: "c1", name: "kind-dev" });
  settings = () => ({ nodeShellImage: null });
  backend = mockBackend({
    cluster_settings_get: () => settings(),
    node_shell_start: (a: {
      onEvent: { onmessage(event: SessionEvent): void };
    }) => {
      sendNodeEvent = (event) => a.onEvent.onmessage(event);
      return "n1";
    },
    session_write: () => null,
    session_resize: () => null,
    session_ack: () => null,
    session_stop: () => null,
  });
});

afterEach(() => {
  resetSessionsForTest();
  resetDockForTest();
  resetCatalogForTest();
  setTermViewFactory(null);
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function context(
  resource: ResourceRef,
  confirm: ActionContext["confirm"] = async () => true,
): ActionContext {
  return {
    clusterId: "c1",
    resource,
    navigate: () => {},
    confirm,
    openEditor: () => {},
    dialog: () => {},
  };
}

/** The terminal area the dock gives the tab, in the document. */
function area(): HTMLElement {
  const element = document.createElement("div");
  document.body.append(element);
  return element;
}

test("Pods offer Logs, Shell, Attach and Port forward before Evict and Force delete; Nodes offer Shell first", () => {
  expect(kindSpec("", "pods")?.actions?.map((a) => a.id)).toEqual([
    "logs",
    "shell",
    "attach",
    "portForward",
    "evict",
    "force-delete",
  ]);
  expect(kindSpec("", "nodes")?.actions?.map((a) => a.id)).toEqual([
    "nodeShell",
    "cordon",
    "uncordon",
    "drain",
  ]);
});

test.each<[string, KindAction, string, LucideIcon, boolean]>([
  ["shell", podShellAction, "Shell", Terminal, true],
  ["attach", podAttachAction, "Attach", Plug, false],
  ["nodeShell", nodeShellAction, "Shell", Terminal, true],
])(
  "the %s action has its label, its icon and its place, and needs no access check",
  (id, action, label, icon, top) => {
    expect(action.id).toBe(id);
    expect(action.label).toBe(label);
    expect(action.icon).toBe(icon);
    expect(action.top ?? false).toBe(top);
    expect(action.requires).toBeUndefined();
    expect(action.visible).toBeUndefined();
  },
);

test("Shell opens a tab on the first running container, and again brings that tab forward", async () => {
  await podShellAction.run(context(PODS), WEB_1);
  expect(useDock.getState().tabs).toEqual([
    {
      id: "shell:c1:shop/web-1",
      kind: "shell",
      clusterId: "c1",
      title: "Shell · web-1",
      dirty: false,
      namespace: "shop",
      pod: "web-1",
      container: "sidecar",
    },
  ]);

  useDock.getState().open(terminalTab("c1", "kind-dev"));
  useDock.getState().setMinimized(true);
  await podShellAction.run(context(PODS), WEB_1);
  expect(useDock.getState().tabs.map((t) => t.id)).toEqual([
    "shell:c1:shop/web-1",
    "terminal:c1",
  ]);
  expect(useDock.getState().activeId).toBe("shell:c1:shop/web-1");
  expect(useDock.getState().minimized).toBe(false);
});

test("Attach opens its own tab next to the Pod's Shell tab", async () => {
  await podShellAction.run(context(PODS), WEB_1);
  await podAttachAction.run(context(PODS), WEB_1);
  expect(useDock.getState().tabs.map((t) => [t.id, t.title])).toEqual([
    ["shell:c1:shop/web-1", "Shell · web-1"],
    ["attach:c1:shop/web-1", "Attach · web-1"],
  ]);
  expect(useDock.getState().activeId).toBe("attach:c1:shop/web-1");
});

test("a Windows node is refused with a toast, before any dialog", async () => {
  const error = vi.spyOn(toast, "error");
  const confirm = vi.fn<ActionContext["confirm"]>(async () => true);
  await nodeShellAction.run(context(NODES, confirm), WINDOWS_NODE);
  expect(error).toHaveBeenCalledWith(
    "The node shell is not supported on Windows nodes.",
  );
  expect(confirm).not.toHaveBeenCalled();
  expect(backend.callsTo("cluster_settings_get")).toEqual([]);
  expect(useDock.getState().tabs).toEqual([]);
});

test("Shell on a node asks first with the cluster's image, then opens the tab, which starts at once", async () => {
  settings = () => ({ nodeShellImage: "busybox:1.37" });
  const confirm = vi.fn<ActionContext["confirm"]>(async () => true);
  await nodeShellAction.run(context(NODES, confirm), WORKER);
  expect(confirm).toHaveBeenCalledWith({
    title: "Open a root shell on worker-1?",
    body: "SkoposIDE creates a privileged Pod (image busybox:1.37, host PID namespace) in kube-system on worker-1 and enters the node with nsenter. Anything you run changes the node itself. The Pod is deleted when you close the tab.",
    confirmLabel: "Open shell",
    danger: true,
  });
  expect(useDock.getState().tabs).toEqual([NODE_SHELL]);
  expect(useDock.getState().activeId).toBe(NODE_SHELL.id);

  // The dock mounts the new tab's view, which starts the session.
  mountView(NODE_SHELL, area());
  expect(backend.callsTo("node_shell_start")).toMatchObject([
    { clusterId: "c1", node: "worker-1" },
  ]);
});

test("No opens nothing, and the tab opened later still waits for Reconnect", async () => {
  const confirm = vi.fn<ActionContext["confirm"]>(async () => false);
  await nodeShellAction.run(context(NODES, confirm), WORKER);
  expect(useDock.getState().tabs).toEqual([]);

  useDock.getState().open(NODE_SHELL);
  mountView(NODE_SHELL, area());
  expect(backend.callsTo("node_shell_start")).toEqual([]);
});

test("the prompt names alpine:3.22 when the settings cannot be read", async () => {
  settings = () => {
    throw new Error("the settings file cannot be read");
  };
  const confirm = vi.fn<ActionContext["confirm"]>(async () => false);
  await nodeShellAction.run(context(NODES, confirm), WORKER);
  expect(confirm.mock.calls[0]?.[0].body).toContain(
    "(image alpine:3.22, host PID namespace)",
  );
});

test("Shell on a node whose session runs brings its tab forward without asking", async () => {
  const confirm = vi.fn<ActionContext["confirm"]>(async () => true);
  await nodeShellAction.run(context(NODES, confirm), WORKER);
  mountView(NODE_SHELL, area());
  useDock.getState().open(terminalTab("c1", "kind-dev"));
  useDock.getState().setMinimized(true);

  await nodeShellAction.run(context(NODES, confirm), WORKER);
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(useDock.getState().activeId).toBe(NODE_SHELL.id);
  expect(useDock.getState().minimized).toBe(false);
  expect(backend.callsTo("node_shell_start")).toHaveLength(1);
});

test("Shell on a node whose session has ended asks again and starts a new session", async () => {
  const confirm = vi.fn<ActionContext["confirm"]>(async () => true);
  await nodeShellAction.run(context(NODES, confirm), WORKER);
  mountView(NODE_SHELL, area());
  await flush();
  sendNodeEvent({ type: "started", tty: true });
  sendNodeEvent({ type: "exited", code: 0 });

  await nodeShellAction.run(context(NODES, confirm), WORKER);
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(backend.callsTo("node_shell_start")).toHaveLength(2);
  expect(backend.callsTo("session_stop")).toEqual([]);
});
