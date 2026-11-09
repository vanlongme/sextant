import { create, type StoreApi, type UseBoundStore } from "zustand";
import { api } from "../../ipc/api";
import { failureMessage } from "../../ipc/client";
import type { ConnectionState } from "../../ipc/generated/ConnectionState";
import type { SessionEvent } from "../../ipc/generated/SessionEvent";
import type { TerminalSize } from "../../ipc/generated/TerminalSize";
import { type CatalogState, useCatalog } from "../../stores/catalog";
import { isSessionTab, type SessionDockTab, useDock } from "../../stores/dock";
import { createTermView, type TermView } from "./termView";

/*
 * The terminal sessions, outside React (spec §5.2). Per tab id the registry keeps the
 * view, the current session and a status entry. It is the only caller of the terminal
 * session commands, and it watches the dock (closed tabs), the catalog (Disconnect and
 * reconnect) and `data-theme`.
 */

export type SessionStatus =
  | "notConnected"
  | "connecting"
  | "connected"
  | "ended"
  | "failed";

/** What a tab's toolbar shows of its session. */
export interface SessionInfo {
  status: SessionStatus;
  /** The exit status, once the session has ended with one. */
  exitCode: number | null;
  /** Whether the session runs with a TTY, once it has started. */
  tty: boolean | null;
  /** The error's message, once the session has failed. */
  message: string | null;
}

export const NOT_CONNECTED: SessionInfo = {
  status: "notConnected",
  exitCode: null,
  tty: null,
  message: null,
};

interface SessionsState {
  /** By tab id. A tab without an entry is Not connected. */
  sessions: Record<string, SessionInfo>;
}

export const useSessions: UseBoundStore<StoreApi<SessionsState>> =
  create<SessionsState>(() => ({ sessions: {} }));

export function useSession(tabId: string): SessionInfo {
  return useSessions((s) => s.sessions[tabId] ?? NOT_CONNECTED);
}

/** Whether the tab's session is starting or running. */
export function sessionRunning(tabId: string): boolean {
  const status = useSessions.getState().sessions[tabId]?.status;
  return status === "connecting" || status === "connected";
}

interface Session {
  /** The backend id, once the start command has answered. */
  id: string | null;
  /** Stopped by Reconnect, Close or Disconnect: nothing of it is written, acknowledged or sent. */
  stopped: boolean;
  /** Exited or failed. */
  over: boolean;
  started: boolean;
  tty: boolean | null;
  /** Bytes xterm has taken in before the id came. */
  unacked: number;
  /** The newest fitted size. */
  size: TerminalSize;
  /** The size the backend has. */
  sentSize: TerminalSize;
  /** Input writes, chained so that they go out in order. */
  writes: Promise<void>;
}

interface Entry {
  /** The tab as last mounted or reconnected; a start reads the dock's newer copy. */
  tab: SessionDockTab;
  view: TermView;
  /** The terminal area that holds the view's host, while the tab is mounted. */
  element: HTMLElement | null;
  observer: ResizeObserver | null;
  frame: number | null;
  /** Whether the next fit that gives a size, on a connected cluster, starts a session. */
  wantsStart: boolean;
  /** How many sessions the tab has started. */
  generation: number;
  session: Session | null;
  focusOnClick: () => void;
}

const entries = new Map<string, Entry>();
/** Node shell tabs the user confirmed before their view existed, with their cluster ids. */
const armed = new Map<string, string>();
const encoder = new TextEncoder();
let unwatch: (() => void) | null = null;

function appTheme(): "light" | "dark" {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function sameSize(a: TerminalSize, b: TerminalSize): boolean {
  return a.cols === b.cols && a.rows === b.rows;
}

function connected(clusterId: string): boolean {
  return useCatalog
    .getState()
    .clusters.some((c) => c.id === clusterId && c.state.status === "connected");
}

/** Whether the view is in the document and no ancestor panel is hidden. */
function shown(entry: Entry): boolean {
  const { element } = entry;
  return element?.isConnected === true && element.closest("[hidden]") === null;
}

function setInfo(tabId: string, info: SessionInfo): void {
  useSessions.setState((s) => ({ sessions: { ...s.sessions, [tabId]: info } }));
}

function dropInfo(tabId: string): void {
  useSessions.setState((s) => {
    const { [tabId]: _dropped, ...sessions } = s.sessions;
    return { sessions };
  });
}

/** The tab as the dock has it now: its container may have changed since the mount. */
function latestTab(entry: Entry): SessionDockTab {
  const tab = useDock.getState().tabs.find((t) => t.id === entry.tab.id);
  return tab && isSessionTab(tab) ? tab : entry.tab;
}

function statusesOf(
  catalog: CatalogState,
): Map<string, ConnectionState["status"]> {
  return new Map(catalog.clusters.map((c) => [c.id, c.state.status] as const));
}

/** Watches the dock, the catalog and the theme, once. */
function watch(): void {
  if (unwatch) return;
  let statuses = statusesOf(useCatalog.getState());
  const stopDock = useDock.subscribe((dock) => {
    const open = new Set(dock.tabs.map((t) => t.id));
    for (const id of [...entries.keys(), ...armed.keys()]) {
      if (!open.has(id)) closeSession(id);
    }
  });
  const stopCatalog = useCatalog.subscribe((catalog) => {
    const before = statuses;
    statuses = statusesOf(catalog);
    for (const [clusterId, status] of statuses) {
      const was = before.get(clusterId);
      if (was === undefined || was === status) continue;
      if (status === "disconnected") stopClusterSessions(clusterId);
      if (status === "connected") {
        for (const entry of entries.values()) {
          if (entry.tab.clusterId === clusterId) tryStart(entry);
        }
      }
    }
  });
  // Every view follows the theme, also while its panel is not in the document.
  const themes = new MutationObserver(() => {
    const theme = appTheme();
    for (const entry of entries.values()) entry.view.setTheme(theme);
  });
  themes.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  unwatch = () => {
    stopDock();
    stopCatalog();
    themes.disconnect();
  };
}

function createEntry(tab: SessionDockTab): Entry {
  const view = createTermView();
  view.setTheme(appTheme());
  const confirmed = armed.delete(tab.id);
  const entry: Entry = {
    tab,
    view,
    element: null,
    observer: null,
    frame: null,
    // A restored Node shell waits for Reconnect and its confirmation.
    wantsStart: tab.kind !== "nodeShell" || confirmed,
    generation: 0,
    session: null,
    focusOnClick: () => view.focus(),
  };
  view.onInput((data) => sendInput(entry, data));
  return entry;
}

function detach(entry: Entry): void {
  entry.observer?.disconnect();
  entry.observer = null;
  if (entry.frame !== null) cancelAnimationFrame(entry.frame);
  entry.frame = null;
  entry.element?.removeEventListener("click", entry.focusOnClick);
  entry.element = null;
  entry.view.host.remove();
}

/** At most one fit per animation frame. */
function scheduleFit(entry: Entry): void {
  if (entry.frame !== null) return;
  entry.frame = requestAnimationFrame(() => {
    entry.frame = null;
    refit(entry);
  });
}

function refit(entry: Entry): void {
  if (entry.wantsStart) {
    tryStart(entry);
    return;
  }
  const size = entry.view.fit();
  if (size) sendSize(entry, size);
}

function tryStart(entry: Entry): void {
  if (!entry.wantsStart || entry.element === null) return;
  if (!connected(entry.tab.clusterId)) return;
  const size = entry.view.fit();
  if (size) start(entry, size);
}

function startCommand(
  tab: SessionDockTab,
  size: TerminalSize,
  onData: (chunk: ArrayBuffer) => void,
  onEvent: (event: SessionEvent) => void,
): Promise<string> {
  switch (tab.kind) {
    case "terminal":
      return api.terminalStart(tab.clusterId, size, onData, onEvent);
    case "shell":
      return api.podExecStart(
        tab.clusterId,
        tab.namespace,
        tab.pod,
        tab.container,
        size,
        onData,
        onEvent,
      );
    case "attach":
      return api.podAttachStart(
        tab.clusterId,
        tab.namespace,
        tab.pod,
        tab.container,
        size,
        onData,
        onEvent,
      );
    case "nodeShell":
      return api.nodeShellStart(tab.clusterId, tab.node, size, onData, onEvent);
  }
}

function start(entry: Entry, size: TerminalSize): void {
  stopSession(entry);
  const tab = latestTab(entry);
  const { view } = entry;
  entry.tab = tab;
  entry.wantsStart = false;
  // A new session does not print under the old one's screen.
  if (entry.generation > 0) view.reset();
  entry.generation += 1;
  const session: Session = {
    id: null,
    stopped: false,
    over: false,
    started: false,
    tty: null,
    unacked: 0,
    size,
    sentSize: size,
    writes: Promise.resolve(),
  };
  entry.session = session;
  view.setInputEnabled(false);
  setInfo(tab.id, { ...NOT_CONNECTED, status: "connecting" });

  function current(): boolean {
    return !session.stopped && entry.session === session;
  }

  function end(info: SessionInfo): void {
    session.over = true;
    view.setInputEnabled(false);
    setInfo(tab.id, info);
  }

  function onData(chunk: ArrayBuffer): void {
    if (!current()) return;
    const bytes = new Uint8Array(chunk);
    view.write(bytes, () => {
      // Reconnect or Close may have come while xterm parsed the chunk.
      if (!current() || session.over) return;
      if (session.id === null) session.unacked += bytes.length;
      else void api.sessionAck(session.id, bytes.length).catch(() => {});
    });
  }

  function onEvent(event: SessionEvent): void {
    if (!current() || session.over) return;
    switch (event.type) {
      case "status":
        view.writeNote(event.message, "note");
        break;
      case "started":
        session.started = true;
        session.tty = event.tty;
        view.setInputEnabled(event.tty);
        setInfo(tab.id, {
          status: "connected",
          exitCode: null,
          tty: event.tty,
          message: null,
        });
        if (shown(entry)) view.focus();
        break;
      case "exited":
        view.writeNote(
          event.code === null
            ? "Session ended"
            : `Session ended · exit status ${event.code}`,
          "note",
        );
        end({
          status: "ended",
          exitCode: event.code,
          tty: session.tty,
          message: null,
        });
        break;
      case "failed": {
        const prefix = session.started
          ? "The session failed"
          : "Could not start the session";
        view.writeNote(`${prefix}: ${event.error.message}`, "error");
        for (const line of event.podEvents) view.writeNote(line, "note");
        end({
          status: "failed",
          exitCode: null,
          tty: session.tty,
          message: event.error.message,
        });
        break;
      }
    }
  }

  startCommand(tab, size, onData, onEvent).then(
    (id) => {
      if (!current()) {
        // Reconnect, Close or Disconnect came first: nothing may live on unseen.
        void api.sessionStop(id).catch(() => {});
        return;
      }
      session.id = id;
      if (session.over) return;
      if (session.unacked > 0) {
        void api.sessionAck(id, session.unacked).catch(() => {});
        session.unacked = 0;
      }
      if (!sameSize(session.size, session.sentSize)) {
        session.sentSize = session.size;
        void api.sessionResize(id, session.size).catch(() => {});
      }
    },
    (e: unknown) => {
      if (!current()) return;
      const message = failureMessage(e);
      view.writeNote(`Could not start the session: ${message}`, "error");
      end({ status: "failed", exitCode: null, tty: null, message });
    },
  );
}

/** Keeps the newest size, and sends it once the backend has an id. */
function sendSize(entry: Entry, size: TerminalSize): void {
  const { session } = entry;
  if (!session || session.stopped || session.over) return;
  session.size = size;
  if (session.id === null || sameSize(size, session.sentSize)) return;
  session.sentSize = size;
  void api.sessionResize(session.id, size).catch(() => {});
}

/** Typed input goes out only while Connected with a TTY. */
function sendInput(entry: Entry, data: string): void {
  const { session } = entry;
  if (!session || session.stopped || session.over) return;
  if (session.id === null || !session.started || session.tty !== true) return;
  const id = session.id;
  const bytes = Array.from(encoder.encode(data));
  // A rejected write is ignored: the event stream reports the end.
  session.writes = session.writes
    .then(() => api.sessionWrite(id, bytes))
    .catch(() => {});
}

function stopSession(entry: Entry): void {
  const { session } = entry;
  if (!session || session.stopped) return;
  session.stopped = true;
  // Without an id yet, the start's answer stops it (see `start`).
  if (session.id !== null && !session.over) {
    void api.sessionStop(session.id).catch(() => {});
  }
}

/** Puts the view into the tab's terminal area, and starts the session when it can. */
export function mountView(tab: SessionDockTab, element: HTMLElement): void {
  watch();
  let entry = entries.get(tab.id);
  if (!entry) {
    entry = createEntry(tab);
    entries.set(tab.id, entry);
  }
  entry.tab = tab;
  if (entry.element) detach(entry);
  entry.element = element;
  element.append(entry.view.host);
  element.addEventListener("click", entry.focusOnClick);
  const mounted = entry;
  entry.observer = new ResizeObserver(() => scheduleFit(mounted));
  entry.observer.observe(element);
  refit(entry);
}

/** Takes the view out of the document. The session keeps running. */
export function unmountView(tabId: string): void {
  const entry = entries.get(tabId);
  if (entry) detach(entry);
}

/** The tab's panel became visible: fit, start when it can, focus a running session. */
export function showView(tabId: string): void {
  const entry = entries.get(tabId);
  if (!entry || entry.element === null) return;
  refit(entry);
  const { session } = entry;
  if (session?.started && !session.over && !session.stopped) {
    entry.view.focus();
  }
}

/**
 * Stops the current session and starts a new one. For a Node shell the caller has
 * asked first. A tab without a view yet starts when its view mounts.
 */
export function reconnect(tab: SessionDockTab): void {
  watch();
  const entry = entries.get(tab.id);
  if (!entry) {
    if (tab.kind === "nodeShell") armed.set(tab.id, tab.clusterId);
    return;
  }
  entry.tab = tab;
  stopSession(entry);
  entry.view.setInputEnabled(false);
  entry.wantsStart = true;
  setInfo(tab.id, NOT_CONNECTED);
  tryStart(entry);
}

/** Close and Detach: stops the session, disposes the view, drops the entry. */
export function closeSession(tabId: string): void {
  armed.delete(tabId);
  const entry = entries.get(tabId);
  if (!entry) return;
  detach(entry);
  stopSession(entry);
  entry.view.dispose();
  entries.delete(tabId);
  dropInfo(tabId);
}

/**
 * Disconnect: stops the cluster's sessions. Their tabs read Not connected and start
 * again once the cluster is connected and they are shown; a Node shell needs Reconnect.
 */
export function stopClusterSessions(clusterId: string): void {
  for (const [id, cluster] of armed) {
    if (cluster === clusterId) armed.delete(id);
  }
  for (const entry of entries.values()) {
    if (entry.tab.clusterId !== clusterId) continue;
    stopSession(entry);
    entry.view.setInputEnabled(false);
    entry.wantsStart = entry.tab.kind !== "nodeShell";
    setInfo(entry.tab.id, NOT_CONNECTED);
  }
}

export function resetSessionsForTest(): void {
  unwatch?.();
  unwatch = null;
  for (const entry of entries.values()) {
    detach(entry);
    entry.view.dispose();
  }
  entries.clear();
  armed.clear();
  useSessions.setState({ sessions: {} });
}
