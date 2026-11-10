import { Channel } from "@tauri-apps/api/core";
import { expect, test } from "vitest";
import { mockBackend } from "../test/ipc";
import { api } from "./api";
import type { PortForwardSpec } from "./generated/PortForwardSpec";

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
