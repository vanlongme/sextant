import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { LogEndReason } from "../../ipc/generated/LogEndReason";
import type { LogEvent } from "../../ipc/generated/LogEvent";
import type { LogLine } from "../../ipc/generated/LogLine";
import type { LogOptions } from "../../ipc/generated/LogOptions";
import type { LogTarget } from "../../ipc/generated/LogTarget";
import { DEPLOYMENTS, PODS } from "../../kinds/refs";
import {
  type LogsDockTab,
  type LogTabOptions,
  logsTab,
} from "../../stores/dock";
import { type Backend, flush, mockBackend } from "../../test/ipc";
import type { LogBuffer } from "./logBuffer";
import { logOptions, useLogStream } from "./useLogStream";

interface Start {
  args: { clusterId: string; target: LogTarget; options: LogOptions };
  send(event: LogEvent): void;
  resolve(id: string): void;
  reject(error: unknown): void;
}

let starts: Start[] = [];
let frames: FrameRequestCallback[] = [];
let backend: Backend;

beforeEach(() => {
  starts = [];
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) => {
    frames.push(run);
    return frames.length;
  });
  backend = mockBackend({
    // Answers only when the test says so, to order the answers.
    logs_start: (a: {
      clusterId: string;
      target: LogTarget;
      options: LogOptions;
      onEvent: { onmessage(event: LogEvent): void };
    }) =>
      new Promise((resolve, reject) => {
        starts.push({
          args: a,
          send: (event) => a.onEvent.onmessage(event),
          resolve,
          reject,
        });
      }),
    logs_stop: () => null,
    session_ack: () => null,
  });
});

afterEach(() => vi.unstubAllGlobals());

const POD_TAB = logsTab("c1", PODS, {
  metadata: { name: "web-1", namespace: "shop" },
  spec: { containers: [{ name: "app" }, { name: "sidecar" }] },
});

const DEPLOY_TAB = logsTab("c1", DEPLOYMENTS, {
  metadata: { name: "web", namespace: "shop" },
});

function withOptions(
  tab: LogsDockTab,
  patch: Partial<LogTabOptions>,
): LogsDockTab {
  return { ...tab, options: { ...tab.options, ...patch } };
}

function mount(tab: LogsDockTab) {
  return renderHook((props: { tab: LogsDockTab }) => useLogStream(props.tab), {
    initialProps: { tab },
  });
}

function line(text: string): LogLine {
  return {
    pod: "web-1",
    container: "app",
    timestamp: null,
    text,
    truncated: false,
  };
}

/** A batch of lines, 10 bytes each. */
function lines(...texts: string[]): LogEvent {
  return { type: "lines", lines: texts.map(line), bytes: 10 * texts.length };
}

function texts(buffer: LogBuffer): string[] {
  return buffer
    .toArray()
    .map((e) => (e.kind === "line" ? e.text : `[${e.marker}]`));
}

async function answer(start: Start, id: string): Promise<void> {
  await act(async () => {
    start.resolve(id);
    await flush();
  });
}

function send(start: Start, event: LogEvent): void {
  act(() => start.send(event));
}

function nextFrame(): void {
  act(() => {
    for (const run of frames.splice(0)) run(0);
  });
}

test.each<[string, LogsDockTab, LogTarget]>([
  [
    "a Pod",
    POD_TAB,
    { kind: "pod", namespace: "shop", pod: "web-1", container: "app" },
  ],
  [
    "all Pods of a workload",
    DEPLOY_TAB,
    {
      kind: "workload",
      resource: DEPLOYMENTS,
      namespace: "shop",
      name: "web",
      container: null,
    },
  ],
  [
    "one Pod of a workload",
    withOptions(DEPLOY_TAB, { pod: "web-7d9f-aaaaa", container: "main" }),
    {
      kind: "pod",
      namespace: "shop",
      pod: "web-7d9f-aaaaa",
      container: "main",
    },
  ],
])("logs_start reads %s", (_name, tab, target) => {
  mount(tab);
  expect(backend.callsTo("logs_start")).toHaveLength(1);
  expect(starts[0].args).toMatchObject({
    clusterId: "c1",
    target,
    options: {
      follow: true,
      previous: false,
      tailLines: 1000,
      sinceSeconds: null,
    },
  });
});

test("Previous reads the previous instance once, without following", () => {
  const options = { ...POD_TAB.options, previous: true, tail: null };
  expect(logOptions(options)).toEqual({
    follow: false,
    previous: true,
    tailLines: null,
    sinceSeconds: null,
  });
});

test("lines go into the buffer, are acknowledged, and render once per frame", async () => {
  const { result } = mount(POD_TAB);
  await answer(starts[0], "s1");
  const before = result.current.version;

  send(starts[0], lines("one", "two"));
  send(starts[0], lines("three"));

  expect(backend.callsTo("session_ack")).toEqual([
    { sessionId: "s1", bytes: 20 },
    { sessionId: "s1", bytes: 10 },
  ]);
  expect(result.current.version).toBe(before);
  nextFrame();
  expect(result.current.version).toBe(before + 1);
  expect(texts(result.current.buffer)).toEqual(["one", "two", "three"]);
  expect(result.current.status).toBe("following");
});

test("lines that arrive before logs_start answers are kept and acknowledged once the id comes", async () => {
  const { result } = mount(POD_TAB);
  send(starts[0], lines("early 1", "early 2", "early 3"));
  send(starts[0], lines("early 4"));
  expect(backend.callsTo("session_ack")).toEqual([]);

  await answer(starts[0], "s1");
  expect(backend.callsTo("session_ack")).toEqual([
    { sessionId: "s1", bytes: 40 },
  ]);

  send(starts[0], lines("late"));
  nextFrame();
  expect(backend.callsTo("session_ack")).toEqual([
    { sessionId: "s1", bytes: 40 },
    { sessionId: "s1", bytes: 10 },
  ]);
  expect(texts(result.current.buffer)).toEqual([
    "early 1",
    "early 2",
    "early 3",
    "early 4",
    "late",
  ]);
});

test("the status reads Connecting until the first event, then Following", async () => {
  const { result } = mount(POD_TAB);
  expect(result.current.status).toBe("connecting");
  await answer(starts[0], "s1");
  expect(result.current.status).toBe("connecting");
  send(starts[0], lines("one"));
  expect(result.current.status).toBe("following");
});

test("with Follow off the read is one-shot and stays Paused, also when it ends", async () => {
  const { result } = mount(withOptions(POD_TAB, { follow: false }));
  expect(starts[0].args.options).toMatchObject({ follow: false });
  await answer(starts[0], "s1");
  send(starts[0], lines("one"));
  expect(result.current.status).toBe("paused");
  send(starts[0], { type: "ended", reason: "completed" });
  expect(result.current.status).toBe("paused");
  expect(result.current.endReason).toBe("completed");
});

test("with Previous on the status reads Previous instance, also when it ends", async () => {
  const { result } = mount(withOptions(POD_TAB, { previous: true }));
  expect(starts[0].args.options).toMatchObject({
    follow: false,
    previous: true,
  });
  await answer(starts[0], "s1");
  send(starts[0], lines("before the restart"));
  expect(result.current.status).toBe("previous");
  send(starts[0], { type: "ended", reason: "completed" });
  expect(result.current.status).toBe("previous");
});

test.each<[LogEndReason]>([["completed"], ["podGone"], ["stopped"]])(
  "an end with reason %s reads Ended while following, and keeps the reason",
  async (reason) => {
    const { result } = mount(POD_TAB);
    await answer(starts[0], "s1");
    send(starts[0], lines("one"));
    send(starts[0], { type: "ended", reason });
    expect(result.current.status).toBe("ended");
    expect(result.current.endReason).toBe(reason);
  },
);

test("a Pod that is gone keeps a one-shot read Paused and still says why", async () => {
  const { result } = mount(withOptions(POD_TAB, { follow: false }));
  await answer(starts[0], "s1");
  send(starts[0], { type: "ended", reason: "podGone" });
  expect(result.current.status).toBe("paused");
  expect(result.current.endReason).toBe("podGone");
});

test("Follow off stops the session and keeps the lines; Follow on starts a new one", async () => {
  const { result, rerender } = mount(POD_TAB);
  await answer(starts[0], "s1");
  send(starts[0], lines("one"));
  nextFrame();

  rerender({ tab: withOptions(POD_TAB, { follow: false }) });
  expect(backend.callsTo("logs_stop")).toEqual([{ sessionId: "s1" }]);
  expect(result.current.status).toBe("paused");
  expect(starts).toHaveLength(1);
  // A line already on its way from the stopped session is dropped.
  send(starts[0], lines("late"));
  nextFrame();
  expect(texts(result.current.buffer)).toEqual(["one"]);
  expect(backend.callsTo("session_ack")).toEqual([
    { sessionId: "s1", bytes: 10 },
  ]);

  rerender({ tab: POD_TAB });
  expect(starts).toHaveLength(2);
  expect(starts[1].args.options).toMatchObject({ follow: true });
  expect(result.current.status).toBe("connecting");
  expect(result.current.buffer.size).toBe(0);
});

test("a new container, tail or Previous restarts the stream; Timestamps and Wrap do not", async () => {
  const { rerender } = mount(POD_TAB);
  await answer(starts[0], "s1");

  rerender({ tab: withOptions(POD_TAB, { container: "sidecar" }) });
  expect(backend.callsTo("logs_stop")).toEqual([{ sessionId: "s1" }]);
  expect(starts).toHaveLength(2);
  expect(starts[1].args.target).toMatchObject({ container: "sidecar" });

  rerender({ tab: withOptions(POD_TAB, { container: "sidecar", tail: 100 }) });
  expect(starts).toHaveLength(3);
  expect(starts[2].args.options).toMatchObject({ tailLines: 100 });

  rerender({
    tab: withOptions(POD_TAB, {
      container: "sidecar",
      tail: 100,
      previous: true,
    }),
  });
  expect(starts).toHaveLength(4);
  expect(starts[3].args.options).toMatchObject({
    follow: false,
    previous: true,
  });

  rerender({
    tab: withOptions(POD_TAB, {
      container: "sidecar",
      tail: 100,
      previous: true,
      timestamps: false,
      wrap: true,
    }),
  });
  expect(starts).toHaveLength(4);
});

test("an older session that answers last is stopped, and none of its lines are kept or acknowledged", async () => {
  const { result, rerender } = mount(POD_TAB);
  rerender({ tab: withOptions(POD_TAB, { tail: 100 }) });
  rerender({ tab: withOptions(POD_TAB, { tail: null }) });
  expect(starts).toHaveLength(3);

  send(starts[0], lines("old early"));
  await answer(starts[2], "s3");
  send(starts[2], lines("current"));
  await answer(starts[0], "s1");
  await answer(starts[1], "s2");
  expect(backend.callsTo("logs_stop")).toEqual([
    { sessionId: "s1" },
    { sessionId: "s2" },
  ]);

  send(starts[0], lines("old 1"));
  send(starts[1], lines("old 2"));
  nextFrame();
  expect(texts(result.current.buffer)).toEqual(["current"]);
  expect(backend.callsTo("session_ack")).toEqual([
    { sessionId: "s3", bytes: 10 },
  ]);
});

test("unmounting stops the session, also one whose id comes later", async () => {
  const first = mount(POD_TAB);
  await answer(starts[0], "s1");
  first.unmount();
  expect(backend.callsTo("logs_stop")).toEqual([{ sessionId: "s1" }]);

  const second = mount(POD_TAB);
  second.unmount();
  await answer(starts[1], "s2");
  expect(backend.callsTo("logs_stop")).toEqual([
    { sessionId: "s1" },
    { sessionId: "s2" },
  ]);
});

test("a failed event and a refused start read Failed with the message, and retry starts again", async () => {
  const { result } = mount(POD_TAB);
  await answer(starts[0], "s1");
  send(starts[0], {
    type: "failed",
    error: {
      code: "Forbidden",
      message: 'pods "web-1" is forbidden: cannot get resource "pods/log"',
      details: null,
    },
  });
  expect(result.current.status).toBe("failed");
  expect(result.current.error).toBe(
    'pods "web-1" is forbidden: cannot get resource "pods/log"',
  );

  act(() => result.current.retry());
  expect(starts).toHaveLength(2);
  expect(result.current.status).toBe("connecting");
  expect(result.current.error).toBeNull();

  await act(async () => {
    starts[1].reject({
      code: "Unreachable",
      message: "cluster c1 is not connected",
      details: null,
    });
    await flush();
  });
  expect(result.current.status).toBe("failed");
  expect(result.current.error).toBe("cluster c1 is not connected");
});

test("a marker goes into the buffer as an entry of its own", async () => {
  const { result } = mount(POD_TAB);
  await answer(starts[0], "s1");
  send(starts[0], {
    type: "marker",
    pod: "web-1",
    container: "app",
    marker: "restarted",
    message: null,
  });
  nextFrame();
  expect(result.current.buffer.toArray()).toEqual([
    {
      kind: "marker",
      seq: 0,
      pod: "web-1",
      container: "app",
      marker: "restarted",
      message: null,
    },
  ]);
  expect(result.current.status).toBe("following");
});
