import type { Channel } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { IpcError } from "../../ipc/generated/IpcError";
import type { SessionEvent } from "../../ipc/generated/SessionEvent";
import { resetCatalogForTest } from "../../stores/catalog";
import {
  nodeShellTabFor,
  podSessionTab,
  resetDockForTest,
  type SessionDockTab,
  terminalTab,
  useDock,
} from "../../stores/dock";
import { type Backend, flush, mockBackend } from "../../test/ipc";
import {
  CONNECTED,
  captureResizeObservers,
  connectClusters,
  type FakeTermView,
  installFakeViews,
  setClusterState,
  stubFrames,
} from "../../test/terminal";
import {
  closeSession,
  mountView,
  NOT_CONNECTED,
  reconnect,
  resetSessionsForTest,
  type SessionInfo,
  sessionRunning,
  showView,
  unmountView,
  useSessions,
} from "./sessions";
import type { NoteTone } from "./terminalText";
import { setTermViewFactory } from "./termView";

/** A start command the test answers by hand, with the session's two channels. */
interface Start {
  cmd: string;
  args: Record<string, unknown>;
  /** Sends output on the session's data channel. */
  data(text: string): void;
  send(event: SessionEvent): void;
  resolve(id: string): void;
  reject(error: unknown): void;
}

type Handlers = Parameters<typeof mockBackend>[0];

const START_COMMANDS = [
  "terminal_start",
  "pod_exec_start",
  "pod_attach_start",
  "node_shell_start",
];
const SIZE = { cols: 80, rows: 24 };
const TERMINAL = terminalTab("c1", "kind-dev");
const SHELL = podSessionTab("shell", "c1", "shop", "web-1", "app");
const ATTACH = podSessionTab("attach", "c1", "shop", "web-1", null);
const NODE_SHELL = nodeShellTabFor("c1", "worker-1");
const OTHER_TERMINAL = terminalTab("c2", "kind-prod");
const FORBIDDEN: IpcError = {
  code: "Forbidden",
  message:
    'pods "web-1" is forbidden: User "dev" cannot create resource "pods/exec" in the namespace "shop"',
  details: null,
};

let starts: Start[] = [];
let views: FakeTermView[] = [];
let frames: ReturnType<typeof stubFrames>;
let observers: ReturnType<typeof captureResizeObservers>;
let backend: Backend;

function mock(over: Handlers = {}): void {
  const handlers: Handlers = {
    session_write: () => null,
    session_resize: () => null,
    session_ack: () => null,
    session_stop: () => null,
  };
  for (const cmd of START_COMMANDS) {
    handlers[cmd] = (args: Record<string, unknown>) =>
      new Promise<string>((resolve, reject) => {
        const onData = args.onData as Channel<ArrayBuffer>;
        const onEvent = args.onEvent as Channel<SessionEvent>;
        starts.push({
          cmd,
          args,
          data: (text) =>
            onData.onmessage(
              Uint8Array.from(new TextEncoder().encode(text)).buffer,
            ),
          send: (event) => onEvent.onmessage(event),
          resolve,
          reject,
        });
      });
  }
  backend = mockBackend({ ...handlers, ...over });
}

beforeEach(() => {
  starts = [];
  views = installFakeViews();
  frames = stubFrames();
  observers = captureResizeObservers();
  mock();
  connectClusters(
    { id: "c1", name: "kind-dev" },
    { id: "c2", name: "kind-prod" },
  );
});

afterEach(() => {
  resetSessionsForTest();
  resetDockForTest();
  resetCatalogForTest();
  setTermViewFactory(null);
  document.body.replaceChildren();
  delete document.documentElement.dataset.theme;
  vi.unstubAllGlobals();
});

function startAt(i: number): Start {
  const start = starts[i];
  if (!start) throw new Error(`no start ${i}`);
  return start;
}

function viewAt(i: number): FakeTermView {
  const view = views[i];
  if (!view) throw new Error(`no view ${i}`);
  return view;
}

/** A terminal area in the document, inside a panel that may be hidden. */
function area(hidden = false): HTMLElement {
  const panel = document.createElement("div");
  panel.hidden = hidden;
  const element = document.createElement("div");
  panel.append(element);
  document.body.append(panel);
  return element;
}

function panelOf(element: HTMLElement): HTMLElement {
  return element.parentElement as HTMLElement;
}

/** Opens the tab in the dock and mounts its view, as TerminalTab does. */
function open(tab: SessionDockTab, hidden = false): HTMLElement {
  useDock.getState().open(tab);
  const element = area(hidden);
  mountView(tab, element);
  return element;
}

async function answer(start: Start, id: string): Promise<void> {
  start.resolve(id);
  await flush();
}

function info(tabId: string): SessionInfo {
  return useSessions.getState().sessions[tabId] ?? NOT_CONNECTED;
}

function calls(cmd: string): Record<string, unknown>[] {
  return backend.callsTo(cmd);
}

/** The Terminal tab, started as t1 and running. */
async function running(
  tty = true,
): Promise<{ start: Start; view: FakeTermView }> {
  open(TERMINAL);
  const start = startAt(0);
  await answer(start, "t1");
  start.send({ type: "started", tty });
  return { start, view: viewAt(0) };
}

test.each<[string, SessionDockTab, string, Record<string, unknown>]>([
  ["Terminal", TERMINAL, "terminal_start", { clusterId: "c1", size: SIZE }],
  [
    "Shell",
    SHELL,
    "pod_exec_start",
    {
      clusterId: "c1",
      namespace: "shop",
      pod: "web-1",
      container: "app",
      size: SIZE,
    },
  ],
  [
    "Attach",
    ATTACH,
    "pod_attach_start",
    {
      clusterId: "c1",
      namespace: "shop",
      pod: "web-1",
      container: null,
      size: SIZE,
    },
  ],
  [
    "a confirmed Node shell",
    NODE_SHELL,
    "node_shell_start",
    { clusterId: "c1", node: "worker-1", size: SIZE },
  ],
])(
  "%s starts with its command, its target and the fitted size",
  (_name, tab, cmd, args) => {
    if (tab.kind === "nodeShell") reconnect(tab);
    open(tab);
    expect(starts.map((s) => s.cmd)).toEqual([cmd]);
    expect(startAt(0).args).toMatchObject(args);
    expect(info(tab.id).status).toBe("connecting");
    expect(viewAt(0).inputEnabled).toBe(false);
    expect(viewAt(0).theme).toBe("dark");
  },
);

test("a tab waits for its cluster to connect, then starts", () => {
  setClusterState("c1", { status: "connecting" });
  open(TERMINAL);
  expect(starts).toEqual([]);
  expect(info(TERMINAL.id)).toEqual(NOT_CONNECTED);

  setClusterState("c1", CONNECTED);
  expect(starts.map((s) => s.cmd)).toEqual(["terminal_start"]);
});

test("output is written, and acknowledged once xterm has taken it in", async () => {
  open(TERMINAL);
  await answer(startAt(0), "t1");
  startAt(0).data("hello\r\n");
  expect(viewAt(0).written).toEqual(["hello\r\n"]);
  expect(calls("session_ack")).toEqual([]);

  viewAt(0).finishWrites();
  expect(calls("session_ack")).toEqual([{ sessionId: "t1", bytes: 7 }]);
});

test("output before the id is acknowledged as one sum when the id comes, then chunk by chunk", async () => {
  open(TERMINAL);
  startAt(0).data("abc");
  startAt(0).data("de");
  viewAt(0).finishWrites();
  expect(viewAt(0).written).toEqual(["abc", "de"]);
  expect(calls("session_ack")).toEqual([]);

  await answer(startAt(0), "t1");
  expect(calls("session_ack")).toEqual([{ sessionId: "t1", bytes: 5 }]);

  startAt(0).data("f");
  viewAt(0).finishWrites();
  expect(calls("session_ack")).toEqual([
    { sessionId: "t1", bytes: 5 },
    { sessionId: "t1", bytes: 1 },
  ]);
});

test("input goes out in order while connected with a TTY, and stops when the session ends", async () => {
  const { start, view } = await running();
  expect(view.inputEnabled).toBe(true);
  view.type("ls\r");
  view.type("é");
  await flush();
  expect(calls("session_write")).toEqual([
    { sessionId: "t1", data: [108, 115, 13] },
    { sessionId: "t1", data: [195, 169] },
  ]);

  start.send({ type: "exited", code: 0 });
  view.type("x");
  await flush();
  expect(calls("session_write")).toHaveLength(2);
  expect(view.inputEnabled).toBe(false);
});

test("input before the session has started, or without a TTY, is dropped", async () => {
  open(TERMINAL);
  const view = viewAt(0);
  view.type("early");
  await answer(startAt(0), "t1");
  view.type("still early");
  startAt(0).send({ type: "started", tty: false });
  view.type("no tty");
  await flush();
  expect(calls("session_write")).toEqual([]);
  expect(view.inputEnabled).toBe(false);
  expect(info(TERMINAL.id)).toEqual({
    status: "connected",
    exitCode: null,
    tty: false,
    message: null,
  });
});

test("a rejected write is ignored, and the next one still goes out", async () => {
  let failures = 1;
  mock({
    session_write: () => {
      if (failures-- > 0) throw new Error("broken pipe");
      return null;
    },
  });
  const { view } = await running();
  view.type("a");
  view.type("b");
  await flush();
  expect(calls("session_write").map((c) => c.data)).toEqual([[97], [98]]);
});

test("resizes are coalesced to one per frame, and skipped when the size has not changed", async () => {
  const { view } = await running();
  view.size = { cols: 100, rows: 30 };
  observers.fire();
  observers.fire();
  expect(frames.pending()).toBe(1);
  frames.next();
  expect(calls("session_resize")).toEqual([
    { sessionId: "t1", size: { cols: 100, rows: 30 } },
  ]);

  observers.fire();
  frames.next();
  expect(calls("session_resize")).toHaveLength(1);
});

test("a status event is a note, and the tab still reads Connecting", () => {
  open(TERMINAL);
  startAt(0).send({ type: "status", message: "Pulling image alpine:3.22" });
  expect(viewAt(0).notes).toEqual([
    { text: "Pulling image alpine:3.22", tone: "note" },
  ]);
  expect(info(TERMINAL.id).status).toBe("connecting");
});

test.each<
  [string, SessionEvent[], { text: string; tone: NoteTone }[], SessionInfo]
>([
  [
    "an exit with a status",
    [
      { type: "started", tty: true },
      { type: "exited", code: 2 },
    ],
    [{ text: "Session ended · exit status 2", tone: "note" }],
    { status: "ended", exitCode: 2, tty: true, message: null },
  ],
  [
    "an exit without a status",
    [
      { type: "started", tty: true },
      { type: "exited", code: null },
    ],
    [{ text: "Session ended", tone: "note" }],
    { status: "ended", exitCode: null, tty: true, message: null },
  ],
  [
    "a failure before the start",
    [
      {
        type: "failed",
        error: FORBIDDEN,
        podEvents: [
          "Warning FailedScheduling: 0/2 nodes are available",
          "Normal Pulling: Pulling image alpine:3.22",
        ],
      },
    ],
    [
      {
        text: `Could not start the session: ${FORBIDDEN.message}`,
        tone: "error",
      },
      {
        text: "Warning FailedScheduling: 0/2 nodes are available",
        tone: "note",
      },
      { text: "Normal Pulling: Pulling image alpine:3.22", tone: "note" },
    ],
    { status: "failed", exitCode: null, tty: null, message: FORBIDDEN.message },
  ],
  [
    "a failure after the start",
    [
      { type: "started", tty: true },
      {
        type: "failed",
        error: {
          code: "Unreachable",
          message: "connection reset by peer",
          details: null,
        },
        podEvents: [],
      },
    ],
    [{ text: "The session failed: connection reset by peer", tone: "error" }],
    {
      status: "failed",
      exitCode: null,
      tty: true,
      message: "connection reset by peer",
    },
  ],
])(
  "%s writes its notes and sets the status",
  async (_name, events, notes, expected) => {
    open(TERMINAL);
    await answer(startAt(0), "t1");
    for (const event of events) startAt(0).send(event);
    expect(viewAt(0).notes).toEqual(notes);
    expect(info(TERMINAL.id)).toEqual(expected);
    expect(viewAt(0).inputEnabled).toBe(false);
  },
);

test("a rejected start writes its message and reads failed", async () => {
  open(TERMINAL);
  startAt(0).reject({
    code: "ToolMissing",
    message: "no shell found: set SHELL",
    details: null,
  });
  await flush();
  expect(viewAt(0).notes).toEqual([
    {
      text: "Could not start the session: no shell found: set SHELL",
      tone: "error",
    },
  ]);
  expect(info(TERMINAL.id)).toEqual({
    status: "failed",
    exitCode: null,
    tty: null,
    message: "no shell found: set SHELL",
  });
});

test("Reconnect stops the session, clears the screen and starts a new one", async () => {
  const { view } = await running();
  reconnect(TERMINAL);
  expect(calls("session_stop")).toEqual([{ sessionId: "t1" }]);
  expect(view.resets).toBe(1);
  expect(starts.map((s) => s.cmd)).toEqual([
    "terminal_start",
    "terminal_start",
  ]);
  expect(info(TERMINAL.id).status).toBe("connecting");
  expect(view.inputEnabled).toBe(false);
});

test("a container change starts a new session on that container", async () => {
  open(SHELL);
  await answer(startAt(0), "x1");
  useDock.getState().setContainer(SHELL.id, "sidecar");
  reconnect({ ...SHELL, container: "sidecar" });
  expect(calls("session_stop")).toEqual([{ sessionId: "x1" }]);
  expect(startAt(1).cmd).toBe("pod_exec_start");
  expect(startAt(1).args).toMatchObject({ pod: "web-1", container: "sidecar" });
});

test("a start that answers after Reconnect is stopped at once, and nothing of it is written or acknowledged", async () => {
  open(TERMINAL);
  const first = startAt(0);
  reconnect(TERMINAL);
  first.data("old output");
  first.send({ type: "started", tty: true });
  await answer(first, "t1");
  expect(calls("session_stop")).toEqual([{ sessionId: "t1" }]);
  expect(viewAt(0).written).toEqual([]);
  expect(info(TERMINAL.id).status).toBe("connecting");

  await answer(startAt(1), "t2");
  viewAt(0).finishWrites();
  expect(calls("session_ack")).toEqual([]);
});

test("closing the tab stops its session, disposes the view and drops its status", async () => {
  const element = open(TERMINAL);
  await answer(startAt(0), "t1");
  useDock.getState().close(TERMINAL.id);
  expect(calls("session_stop")).toEqual([{ sessionId: "t1" }]);
  expect(viewAt(0).disposed).toBe(true);
  expect(useSessions.getState().sessions).toEqual({});
  expect(element.childElementCount).toBe(0);
  expect(observers.watched()).toBe(0);
});

test("a session that has ended stops nothing when its tab closes", async () => {
  const { start } = await running();
  start.send({ type: "exited", code: 0 });
  closeSession(TERMINAL.id);
  expect(calls("session_stop")).toEqual([]);
});

test("Disconnect stops the cluster's sessions; its tabs read Not connected and start again on the reconnected cluster", async () => {
  open(TERMINAL);
  await answer(startAt(0), "t1");
  open(OTHER_TERMINAL);
  await answer(startAt(1), "t2");

  setClusterState("c1", { status: "disconnected" });
  expect(calls("session_stop")).toEqual([{ sessionId: "t1" }]);
  expect(info(TERMINAL.id)).toEqual(NOT_CONNECTED);
  expect(info(OTHER_TERMINAL.id).status).toBe("connecting");
  expect(viewAt(0).inputEnabled).toBe(false);

  // The cluster screen goes away, the cluster connects again, the screen comes back.
  unmountView(TERMINAL.id);
  setClusterState("c1", CONNECTED);
  expect(starts).toHaveLength(2);
  mountView(TERMINAL, area());
  expect(starts).toHaveLength(3);
  expect(startAt(2).args).toMatchObject({ clusterId: "c1" });
  expect(viewAt(0).resets).toBe(1);
});

test("a tab still in view starts again as soon as its cluster is connected again", async () => {
  open(TERMINAL);
  await answer(startAt(0), "t1");
  setClusterState("c1", { status: "disconnected" });
  setClusterState("c1", { status: "connecting" });
  expect(starts).toHaveLength(1);
  setClusterState("c1", CONNECTED);
  expect(starts).toHaveLength(2);
});

test("a failed connection stops nothing", async () => {
  open(TERMINAL);
  await answer(startAt(0), "t1");
  setClusterState("c1", {
    status: "failed",
    kind: "unreachable",
    message: "dial tcp 127.0.0.1:6443: connect: connection refused",
  });
  expect(calls("session_stop")).toEqual([]);
  expect(info(TERMINAL.id).status).toBe("connecting");
});

test("a Node shell stopped by Disconnect waits for Reconnect once the cluster is back", async () => {
  reconnect(NODE_SHELL);
  open(NODE_SHELL);
  await answer(startAt(0), "n1");
  setClusterState("c1", { status: "disconnected" });
  expect(calls("session_stop")).toEqual([{ sessionId: "n1" }]);

  setClusterState("c1", CONNECTED);
  showView(NODE_SHELL.id);
  observers.fire();
  frames.next();
  expect(starts).toHaveLength(1);
  expect(info(NODE_SHELL.id)).toEqual(NOT_CONNECTED);

  reconnect(NODE_SHELL);
  expect(starts).toHaveLength(2);
});

test("a session keeps running while its view is unmounted, and the view comes back at the new size", async () => {
  const { start, view } = await running();
  unmountView(TERMINAL.id);
  expect(view.host.isConnected).toBe(false);
  expect(observers.watched()).toBe(0);

  start.data("while away");
  view.finishWrites();
  expect(calls("session_ack")).toEqual([{ sessionId: "t1", bytes: 10 }]);
  expect(calls("session_stop")).toEqual([]);

  view.size = { cols: 132, rows: 40 };
  const element = area();
  mountView(TERMINAL, element);
  expect(element.firstElementChild).toBe(view.host);
  expect(calls("session_resize")).toEqual([
    { sessionId: "t1", size: { cols: 132, rows: 40 } },
  ]);
  expect(starts).toHaveLength(1);
  expect(view.written).toEqual(["while away"]);
  expect(info(TERMINAL.id).status).toBe("connected");
});

test("a restored Node shell tab reads Not connected until Reconnect", () => {
  open(NODE_SHELL);
  showView(NODE_SHELL.id);
  observers.fire();
  frames.next();
  expect(starts).toEqual([]);
  expect(info(NODE_SHELL.id)).toEqual(NOT_CONNECTED);

  reconnect(NODE_SHELL);
  expect(starts.map((s) => s.args)).toMatchObject([
    { clusterId: "c1", node: "worker-1" },
  ]);
});

test("the view takes the focus when its session starts while its tab is shown, when shown again, and on a click", () => {
  const first = open(TERMINAL);
  const second = open(OTHER_TERMINAL);
  panelOf(second).hidden = true;
  startAt(0).send({ type: "started", tty: true });
  startAt(1).send({ type: "started", tty: true });
  expect(viewAt(0).focuses).toBe(1);
  expect(viewAt(1).focuses).toBe(0);

  first.click();
  expect(viewAt(0).focuses).toBe(2);

  panelOf(second).hidden = false;
  showView(OTHER_TERMINAL.id);
  expect(viewAt(1).focuses).toBe(1);
});

test("sessionRunning is true while a session starts or runs", () => {
  expect(sessionRunning(TERMINAL.id)).toBe(false);
  open(TERMINAL);
  expect(sessionRunning(TERMINAL.id)).toBe(true);
  startAt(0).send({ type: "started", tty: true });
  expect(sessionRunning(TERMINAL.id)).toBe(true);
  startAt(0).send({ type: "exited", code: 0 });
  expect(sessionRunning(TERMINAL.id)).toBe(false);
});

// Review Focus 1
test.each(["Disconnect", "Close"])(
  "%s while a start is in flight: its late id is stopped, and nothing of it is written or acknowledged",
  async (how) => {
    open(TERMINAL);
    const start = startAt(0);
    if (how === "Disconnect") setClusterState("c1", { status: "disconnected" });
    else useDock.getState().close(TERMINAL.id);
    start.data("late output");
    start.send({ type: "started", tty: true });
    await answer(start, "t1");
    viewAt(0).finishWrites();
    expect(calls("session_stop")).toEqual([{ sessionId: "t1" }]);
    expect(viewAt(0).written).toEqual([]);
    expect(calls("session_ack")).toEqual([]);
    expect(info(TERMINAL.id)).toEqual(NOT_CONNECTED);
  },
);

// Review Focus 2
test("a restored tab hidden at mount starts once, when first shown, never twice", () => {
  const element = open(TERMINAL, true);
  observers.fire();
  frames.next();
  showView(TERMINAL.id);
  expect(starts).toEqual([]);

  panelOf(element).hidden = false;
  showView(TERMINAL.id);
  observers.fire();
  frames.next();
  showView(TERMINAL.id);
  expect(starts.map((s) => s.cmd)).toEqual(["terminal_start"]);
});

// Review Focus 3
test("a resize between the start and its id goes out once, with the newest size, when the id comes", async () => {
  open(TERMINAL);
  const view = viewAt(0);
  view.size = { cols: 100, rows: 30 };
  observers.fire();
  frames.next();
  view.size = { cols: 120, rows: 40 };
  observers.fire();
  frames.next();
  expect(calls("session_resize")).toEqual([]);

  await answer(startAt(0), "t1");
  expect(calls("session_resize")).toEqual([
    { sessionId: "t1", size: { cols: 120, rows: 40 } },
  ]);
});

test("a size that comes back to the start's before the id sends no resize", async () => {
  open(TERMINAL);
  const view = viewAt(0);
  view.size = { cols: 100, rows: 30 };
  observers.fire();
  frames.next();
  view.size = { ...SIZE };
  observers.fire();
  frames.next();
  await answer(startAt(0), "t1");
  expect(calls("session_resize")).toEqual([]);
});

// Review Focus 4
test("a write that finishes after Reconnect or Close acknowledges nothing for the old session, and throws nothing", async () => {
  const { start, view } = await running();
  start.data("a big chunk");
  reconnect(TERMINAL);
  expect(() => view.finishWrites()).not.toThrow();

  await answer(startAt(1), "t2");
  startAt(1).data("next");
  useDock.getState().close(TERMINAL.id);
  expect(() => view.finishWrites()).not.toThrow();
  expect(calls("session_ack")).toEqual([]);
});

// Review Focus 5
test("a theme switch while the panels are unmounted still reaches their views", async () => {
  open(TERMINAL);
  const view = viewAt(0);
  expect(view.theme).toBe("dark");
  unmountView(TERMINAL.id);

  document.documentElement.dataset.theme = "light";
  await flush();
  expect(view.theme).toBe("light");

  mountView(TERMINAL, area());
  expect(view.theme).toBe("light");
});
