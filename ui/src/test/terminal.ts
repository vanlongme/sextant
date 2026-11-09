import { vi } from "vitest";
import type { NoteTone } from "../features/terminal/terminalText";
import {
  setTermViewFactory,
  type TermView,
} from "../features/terminal/termView";
import type { ConnectionState } from "../ipc/generated/ConnectionState";
import type { TerminalSize } from "../ipc/generated/TerminalSize";
import { useCatalog } from "../stores/catalog";
import { clusterEntry } from "./ipc";

/** A `TermView` that records what it is told, for unit tests. */
export class FakeTermView implements TermView {
  readonly host: HTMLDivElement = document.createElement("div");
  /** What fit() gives while the host is in the document and no ancestor is hidden. */
  size: TerminalSize = { cols: 80, rows: 24 };
  /** Each write since the last reset, decoded. */
  written: string[] = [];
  /** The notes since the last reset. */
  notes: { text: string; tone: NoteTone }[] = [];
  inputEnabled = false;
  resets = 0;
  focuses = 0;
  theme: "light" | "dark" | null = null;
  disposed = false;
  private pending: (() => void)[] = [];
  private listener: ((data: string) => void) | null = null;

  write(data: Uint8Array, done: () => void): void {
    this.written.push(new TextDecoder().decode(data));
    this.pending.push(done);
  }

  /** Runs the `done` of every write so far, as xterm does once it has parsed them. */
  finishWrites(): void {
    const done = this.pending;
    this.pending = [];
    for (const run of done) run();
  }

  writeNote(text: string, tone: NoteTone): void {
    this.notes.push({ text, tone });
  }

  onInput(listener: (data: string) => void): void {
    this.listener = listener;
  }

  /** What typing `data` into xterm sends. */
  type(data: string): void {
    this.listener?.(data);
  }

  setInputEnabled(enabled: boolean): void {
    this.inputEnabled = enabled;
  }

  fit(): TerminalSize | null {
    if (!this.host.isConnected || this.host.closest("[hidden]") !== null) {
      return null;
    }
    return { ...this.size };
  }

  reset(): void {
    this.resets += 1;
    this.written = [];
    this.notes = [];
  }

  focus(): void {
    this.focuses += 1;
  }

  setTheme(theme: "light" | "dark"): void {
    this.theme = theme;
  }

  dispose(): void {
    this.disposed = true;
    this.host.remove();
  }
}

/** Makes every new view a fake. The array fills as views are made. */
export function installFakeViews(): FakeTermView[] {
  const views: FakeTermView[] = [];
  setTermViewFactory(() => {
    const view = new FakeTermView();
    views.push(view);
    return view;
  });
  return views;
}

/** Stubs `ResizeObserver`; `fire()` calls every observer that watches something. */
export function captureResizeObservers(): {
  fire(): void;
  watched(): number;
} {
  const live = new Set<CapturedObserver>();
  class CapturedObserver {
    readonly targets = new Set<Element>();
    readonly callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }
    observe(target: Element): void {
      this.targets.add(target);
      live.add(this);
    }
    unobserve(target: Element): void {
      this.targets.delete(target);
    }
    disconnect(): void {
      this.targets.clear();
      live.delete(this);
    }
  }
  vi.stubGlobal("ResizeObserver", CapturedObserver);
  return {
    fire: () => {
      for (const observer of [...live]) {
        observer.callback([], observer as unknown as ResizeObserver);
      }
    },
    watched: () => [...live].reduce((n, o) => n + o.targets.size, 0),
  };
}

/** Stubs animation frames; `next()` runs the frames asked for so far. */
export function stubFrames(): { next(): void; pending(): number } {
  let queue = new Map<number, FrameRequestCallback>();
  let last = 0;
  vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) => {
    last += 1;
    queue.set(last, run);
    return last;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    queue.delete(id);
  });
  return {
    next: () => {
      const runs = [...queue.values()];
      queue = new Map();
      for (const run of runs) run(0);
    },
    pending: () => queue.size,
  };
}

export const CONNECTED: ConnectionState = {
  status: "connected",
  info: {
    version: "v1.33.1",
    distribution: "kind",
    nodeCount: 2,
    namespaces: ["default", "shop"],
    namespacesRestricted: false,
    isAdmin: true,
  },
};

/** A loaded catalog that holds these clusters, connected. */
export function connectClusters(
  ...clusters: { id: string; name: string }[]
): void {
  useCatalog.setState({
    loading: false,
    error: null,
    clusters: clusters.map((c) =>
      clusterEntry({ ...c, contextName: c.name, state: CONNECTED }),
    ),
  });
}

export function setClusterState(id: string, state: ConnectionState): void {
  useCatalog.setState((s) => ({
    clusters: s.clusters.map((c) => (c.id === id ? { ...c, state } : c)),
  }));
}
