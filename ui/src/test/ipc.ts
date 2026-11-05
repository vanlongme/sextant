import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import { act } from "@testing-library/react";
import type { ClusterEntry } from "../ipc/generated/ClusterEntry";

// biome-ignore lint/suspicious/noExplicitAny: command arguments are checked per test.
type Handler = (args: any) => unknown;

export interface Backend {
  calls: { cmd: string; args: Record<string, unknown> }[];
  callsTo(cmd: string): Record<string, unknown>[];
}

/**
 * Mocks the backend. A command with no handler rejects, so a test cannot pass
 * through a call it did not expect. Events are mocked too: see `emitEvent`.
 */
export function mockBackend(handlers: Record<string, Handler>): Backend {
  const backend: Backend = {
    calls: [],
    callsTo: (cmd) =>
      backend.calls.filter((c) => c.cmd === cmd).map((c) => c.args),
  };
  mockIPC(
    (cmd, args) => {
      backend.calls.push({
        cmd,
        args: (args ?? {}) as Record<string, unknown>,
      });
      if (cmd === "plugin:app|version") return "0.1.0";
      const handler = handlers[cmd];
      if (!handler) throw new Error(`unexpected command ${cmd}`);
      return handler(args);
    },
    { shouldMockEvents: true },
  );
  return backend;
}

/** Sends a backend event and lets the listeners and their reloads finish. */
export async function emitEvent(
  name: string,
  payload?: unknown,
): Promise<void> {
  await act(async () => {
    await emit(name, payload);
    await flush();
  });
}

export async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

export function clusterEntry(partial: Partial<ClusterEntry>): ClusterEntry {
  const contextName = partial.contextName ?? partial.name ?? "ctx";
  return {
    id: `id-${contextName}`,
    name: contextName,
    contextName,
    server: "http://127.0.0.1:1",
    icon: null,
    source: { kind: "synced", path: "/home/me/.kube/config" },
    problem: null,
    state: { status: "disconnected" },
    ...partial,
  };
}
