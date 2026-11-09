import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { WatchEvent } from "../../ipc/generated/WatchEvent";
import type { KubeObject } from "../../kinds/objects";
import { resetCatalogForTest } from "../../stores/catalog";
import {
  isSessionTab,
  nodeShellTabFor,
  podSessionTab,
  resetDockForTest,
  type SessionDockTab,
  terminalTab,
  useDock,
} from "../../stores/dock";
import { resetResourcesForTest } from "../../stores/resources";
import { type Backend, flush, mockBackend } from "../../test/ipc";
import {
  captureResizeObservers,
  connectClusters,
  type FakeTermView,
  installFakeViews,
  stubFrames,
} from "../../test/terminal";
import {
  NOT_CONNECTED,
  resetSessionsForTest,
  type SessionInfo,
  useSessions,
} from "./sessions";
import { TerminalTab } from "./TerminalTab";
import { TERMINAL_CONTEXT_NOTE } from "./TerminalToolbar";
import { setTermViewFactory } from "./termView";

const TERMINAL = terminalTab("c1", "kind-dev");
const SHELL = podSessionTab("shell", "c1", "shop", "web-1", "app");
const ATTACH = podSessionTab("attach", "c1", "shop", "web-1", null);
const NODE_SHELL = nodeShellTabFor("c1", "worker-1");
const RUNNING: SessionInfo = {
  status: "connected",
  exitCode: null,
  tty: true,
  message: null,
};

let backend: Backend;
let views: FakeTermView[] = [];
let watchers = new Map<string, (event: WatchEvent) => void>();
let settings: () => unknown = () => ({ nodeShellImage: null });
let version = 0;

function mock(): void {
  backend = mockBackend({
    terminal_start: () => "t1",
    pod_exec_start: () => "x1",
    pod_attach_start: () => "a1",
    node_shell_start: () => "n1",
    session_write: () => null,
    session_resize: () => null,
    session_ack: () => null,
    session_stop: () => null,
    cluster_settings_get: () => settings(),
    resources_subscribe: (a: {
      resource: { plural: string };
      onEvent: { onmessage(event: WatchEvent): void };
    }) => {
      watchers.set(a.resource.plural, (event) => a.onEvent.onmessage(event));
      return `sub-${a.resource.plural}`;
    },
    resources_unsubscribe: () => null,
  });
}

beforeEach(() => {
  views = installFakeViews();
  stubFrames();
  captureResizeObservers();
  resetResourcesForTest();
  watchers = new Map();
  settings = () => ({ nodeShellImage: null });
  connectClusters({ id: "c1", name: "kind-dev" });
  mock();
});

afterEach(() => {
  resetSessionsForTest();
  resetDockForTest();
  resetResourcesForTest();
  resetCatalogForTest();
  setTermViewFactory(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Reads the tab from the store, as the dock does. */
function Live({ id }: { id: string }) {
  const tab = useDock((s) => s.tabs.find((t) => t.id === id));
  return tab && isSessionTab(tab) ? <TerminalTab tab={tab} shown /> : null;
}

async function show(tab: SessionDockTab): Promise<void> {
  useDock.getState().open(tab);
  render(<Live id={tab.id} />);
  await act(flush);
}

function viewAt(i: number): FakeTermView {
  const view = views[i];
  if (!view) throw new Error(`no view ${i}`);
  return view;
}

function pod(containers: string[], statuses: unknown[] = []): KubeObject {
  version += 1;
  return {
    metadata: {
      name: "web-1",
      namespace: "shop",
      resourceVersion: String(version),
    },
    spec: { containers: containers.map((name) => ({ name })) },
    status: { containerStatuses: statuses },
  };
}

async function objects(plural: string, items: KubeObject[]): Promise<void> {
  await act(async () => {
    watchers.get(plural)?.({ type: "snapshot", items } as WatchEvent);
    await flush();
  });
}

function setInfo(tabId: string, info: SessionInfo): void {
  act(() =>
    useSessions.setState((s) => ({
      sessions: { ...s.sessions, [tabId]: info },
    })),
  );
}

function statusText(): string | null {
  return screen.getByTestId("terminal-status").textContent;
}

/** Opens a toolbar select and gives its options. */
async function openSelect(id: string): Promise<string[]> {
  fireEvent.keyDown(screen.getByTestId(id), { key: "Enter" });
  const options = await screen.findAllByRole("option");
  return options.map((o) => o.textContent ?? "");
}

async function pick(name: string): Promise<void> {
  fireEvent.click(screen.getByRole("option", { name }));
  await act(flush);
}

test("the Terminal tab has its status, the context note and Reconnect over the terminal area", async () => {
  await show(TERMINAL);

  const toolbar = screen.getByRole("group", { name: "Terminal options" });
  expect(toolbar.textContent).toBe(
    `Connecting…${TERMINAL_CONTEXT_NOTE}Reconnect`,
  );
  expect(TERMINAL_CONTEXT_NOTE).toBe(
    "kubectl and helm in this tab use this cluster's context.",
  );
  expect(screen.queryByTestId("attach-detach")).toBeNull();
  const area = screen.getByTestId("terminal-view");
  expect(area.className).toBe("view");
  expect(area.firstElementChild).toBe(viewAt(0).host);
  expect(backend.callsTo("terminal_start")).toHaveLength(1);
});

test.each<[string, SessionDockTab, SessionInfo, string, string]>([
  [
    "Connecting",
    TERMINAL,
    { ...NOT_CONNECTED, status: "connecting" },
    "warn",
    "Connecting…",
  ],
  ["a running local shell", TERMINAL, RUNNING, "ok", "Local shell"],
  ["a running Shell", SHELL, RUNNING, "ok", "Connected"],
  ["a running Node shell", NODE_SHELL, RUNNING, "ok", "Connected"],
  ["a running Attach", ATTACH, RUNNING, "ok", "Attached"],
  [
    "an exit with a status",
    TERMINAL,
    { status: "ended", exitCode: 130, tty: true, message: null },
    "neutral",
    "Exited · status 130",
  ],
  [
    "an exit without a status",
    SHELL,
    { status: "ended", exitCode: null, tty: true, message: null },
    "neutral",
    "Exited",
  ],
  [
    "a failure",
    SHELL,
    { status: "failed", exitCode: null, tty: null, message: "forbidden" },
    "danger",
    "Not connected",
  ],
  ["no session", NODE_SHELL, NOT_CONNECTED, "neutral", "Not connected"],
])("%s shows its dot and label", async (_name, tab, info, tone, label) => {
  await show(tab);
  setInfo(tab.id, info);
  expect(statusText()).toBe(label);
  const dot = screen
    .getByTestId("terminal-status")
    .querySelector('[role="img"]');
  expect(dot?.getAttribute("aria-label")).toBe(label);
  expect(dot?.classList.contains(tone)).toBe(true);
});

test("Shell offers the container choice only with two or more containers, waiting ones with their reason", async () => {
  await show(SHELL);
  await objects("pods", [pod(["app"])]);
  expect(screen.queryByTestId("shell-container")).toBeNull();
  expect(screen.getByTestId("terminal-reconnect")).toBeTruthy();

  await objects("pods", [
    pod(
      ["app", "sidecar"],
      [
        { name: "app", state: { running: {} } },
        { name: "sidecar", state: { waiting: { reason: "CrashLoopBackOff" } } },
      ],
    ),
  ]);
  expect(await openSelect("shell-container")).toEqual([
    "app",
    "sidecar (CrashLoopBackOff)",
  ]);
});

test("picking a container saves it on the tab and starts a new session on it", async () => {
  await show(SHELL);
  await objects("pods", [pod(["app", "sidecar"])]);
  await openSelect("shell-container");
  await pick("sidecar");

  expect(useDock.getState().tabs[0]).toMatchObject({ container: "sidecar" });
  expect(backend.callsTo("session_stop")).toEqual([{ sessionId: "x1" }]);
  expect(backend.callsTo("pod_exec_start").map((a) => a.container)).toEqual([
    "app",
    "sidecar",
  ]);
});

test("Attach has the container choice, Detach instead of Reconnect, and its note once started", async () => {
  await show(ATTACH);
  await objects("pods", [pod(["app", "sidecar"])]);
  expect(screen.getByTestId("attach-container")).toBeTruthy();
  expect(screen.queryByTestId("terminal-reconnect")).toBeNull();
  expect(screen.getByTestId("attach-detach").textContent).toBe("Detach");
  expect(screen.queryByTestId("attach-note")).toBeNull();

  // A restored Attach tab has no container: the note names the Pod's first one.
  setInfo(ATTACH.id, { ...RUNNING, tty: false });
  expect(screen.getByTestId("attach-note").textContent).toBe(
    "Attached to container app (PID 1). It runs without a TTY (tty: false), so input is off and only its output shows.",
  );
  setInfo(ATTACH.id, RUNNING);
  expect(screen.getByTestId("attach-note").textContent).toBe(
    "Attached to container app (PID 1). Input goes to that process.",
  );
});

test("the Node shell toolbar has its status and Reconnect only", async () => {
  await show(NODE_SHELL);
  const toolbar = screen.getByRole("group", { name: "Terminal options" });
  expect(toolbar.textContent).toBe("Not connectedReconnect");
});

test("Detach closes the tab, which stops the session and disposes the view", async () => {
  await show(ATTACH);
  fireEvent.click(screen.getByTestId("attach-detach"));
  await act(flush);

  expect(useDock.getState().tabs).toEqual([]);
  expect(backend.callsTo("session_stop")).toEqual([{ sessionId: "a1" }]);
  expect(viewAt(0).disposed).toBe(true);
  expect(screen.queryByTestId("terminal-tab")).toBeNull();
});

test("Reconnect on the Terminal tab starts a new session at once", async () => {
  await show(TERMINAL);
  fireEvent.click(screen.getByTestId("terminal-reconnect"));
  await act(flush);

  expect(backend.callsTo("session_stop")).toEqual([{ sessionId: "t1" }]);
  expect(backend.callsTo("terminal_start")).toHaveLength(2);
  expect(viewAt(0).resets).toBe(1);
  expect(backend.callsTo("cluster_settings_get")).toEqual([]);
});

test("Reconnect on a Node shell asks first: Cancel leaves it, Open shell starts it", async () => {
  settings = () => ({ nodeShellImage: "" });
  await show(NODE_SHELL);

  fireEvent.click(screen.getByTestId("terminal-reconnect"));
  const dialog = await screen.findByRole("dialog");
  expect(dialog.textContent).toContain("Open a root shell on worker-1?");
  expect(dialog.textContent).toContain(
    "SkoposIDE creates a privileged Pod (image alpine:3.22, host PID namespace) in kube-system on worker-1 and enters the node with nsenter.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await act(flush);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(backend.callsTo("node_shell_start")).toEqual([]);
  expect(statusText()).toBe("Not connected");

  fireEvent.click(screen.getByTestId("terminal-reconnect"));
  await screen.findByRole("dialog");
  fireEvent.click(screen.getByRole("button", { name: "Open shell" }));
  await act(flush);
  expect(backend.callsTo("node_shell_start")).toMatchObject([
    { clusterId: "c1", node: "worker-1" },
  ]);
  expect(statusText()).toBe("Connecting…");
});

test("a click in the terminal area focuses the view", async () => {
  await show(TERMINAL);
  const before = viewAt(0).focuses;
  fireEvent.click(screen.getByTestId("terminal-view"));
  expect(viewAt(0).focuses).toBe(before + 1);
});
