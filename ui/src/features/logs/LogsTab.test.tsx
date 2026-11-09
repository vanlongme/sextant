import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { LogEvent } from "../../ipc/generated/LogEvent";
import type { LogLine } from "../../ipc/generated/LogLine";
import type { WatchEvent } from "../../ipc/generated/WatchEvent";
import type { KubeObject } from "../../kinds/objects";
import { DEPLOYMENTS, PODS } from "../../kinds/refs";
import {
  type LogsDockTab,
  type LogTabOptions,
  logsTab,
  resetDockForTest,
  useDock,
} from "../../stores/dock";
import { resetResourcesForTest } from "../../stores/resources";
import { type Backend, flush, mockBackend } from "../../test/ipc";
import { mockElementSize } from "../../test/size";
import { LogsTab } from "./LogsTab";
import { allPodsLabel } from "./LogsToolbar";

let frames: FrameRequestCallback[] = [];
let sessions = 0;
let sendLog: (event: LogEvent) => void = () => {};
let watchers = new Map<string, (event: WatchEvent) => void>();

function backend(extra: Parameters<typeof mockBackend>[0] = {}): Backend {
  return mockBackend({
    logs_start: (a: { onEvent: { onmessage(event: LogEvent): void } }) => {
      sendLog = (event) => a.onEvent.onmessage(event);
      sessions += 1;
      return `s${sessions}`;
    },
    logs_stop: () => null,
    session_ack: () => null,
    resources_subscribe: (a: {
      resource: { plural: string };
      onEvent: { onmessage(event: WatchEvent): void };
    }) => {
      watchers.set(a.resource.plural, (event) => a.onEvent.onmessage(event));
      return `sub-${a.resource.plural}`;
    },
    resources_unsubscribe: () => null,
    ...extra,
  });
}

beforeEach(() => {
  frames = [];
  sessions = 0;
  watchers = new Map();
  vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) => {
    frames.push(run);
    return frames.length;
  });
  mockElementSize(1000, 600);
  resetResourcesForTest();
});

afterEach(() => {
  resetDockForTest();
  resetResourcesForTest();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Reads the tab from the store, as the dock does, so option changes show. */
function Live({ id }: { id: string }) {
  const tab = useDock((s) => s.tabs.find((t) => t.id === id));
  return tab?.kind === "logs" ? <LogsTab tab={tab} /> : null;
}

async function show(tab: LogsDockTab): Promise<void> {
  useDock.getState().open(tab);
  render(<Live id={tab.id} />);
  await act(flush);
}

function nextFrame(): void {
  act(() => {
    for (const run of frames.splice(0)) run(0);
  });
}

function send(event: LogEvent): void {
  act(() => sendLog(event));
  nextFrame();
}

async function objects(plural: string, items: KubeObject[]): Promise<void> {
  await act(async () => {
    watchers.get(plural)?.({ type: "snapshot", items } as WatchEvent);
    await flush();
  });
}

function line(text: string, over: Partial<LogLine> = {}): LogLine {
  return {
    pod: "web-7d9f-aaaaa",
    container: "main",
    timestamp: "2026-11-09T10:00:00.000000000Z",
    text,
    truncated: false,
    ...over,
  };
}

function lines(...items: LogLine[]): LogEvent {
  return { type: "lines", lines: items, bytes: 10 * items.length };
}

interface PodShape {
  labels?: Record<string, string>;
  init?: string[];
  containers?: string[];
  phase?: string;
  statuses?: object[];
}

function pod(name: string, shape: PodShape = {}): KubeObject {
  return {
    metadata: {
      name,
      namespace: "shop",
      labels: shape.labels ?? { app: "web" },
      resourceVersion: "1",
    },
    spec: {
      initContainers: (shape.init ?? []).map((n) => ({ name: n })),
      containers: (shape.containers ?? ["main"]).map((n) => ({ name: n })),
    },
    status: {
      phase: shape.phase ?? "Running",
      containerStatuses: shape.statuses ?? [],
    },
  };
}

const DEPLOYMENT: KubeObject = {
  metadata: { name: "web", namespace: "shop" },
  spec: {
    selector: { matchLabels: { app: "web" } },
    template: { spec: { containers: [{ name: "main" }] } },
  },
};

const POD_TAB = logsTab("c1", PODS, pod("web-7d9f-aaaaa"));
const WORKLOAD_TAB = logsTab("c1", DEPLOYMENTS, DEPLOYMENT);

function withOptions(
  tab: LogsDockTab,
  patch: Partial<LogTabOptions>,
): LogsDockTab {
  return { ...tab, options: { ...tab.options, ...patch } };
}

const switchOf = (id: string) =>
  within(screen.getByTestId(id)).getByRole<HTMLInputElement>("switch");
const toggle = (id: string) => fireEvent.click(switchOf(id));
const status = () => screen.getByTestId("logs-status").textContent;
const empty = () => screen.queryByTestId("logs-empty")?.textContent ?? null;

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

test("a Pod tab shows Lines, the switches and the status, and no Pods choice", async () => {
  backend();
  await show(POD_TAB);

  expect(screen.getByRole("group", { name: "Log options" })).toBeTruthy();
  expect(screen.queryByTestId("logs-pods")).toBeNull();
  expect(screen.queryByTestId("logs-container")).toBeNull();
  expect(screen.getByRole("combobox", { name: "Lines" })).toBe(
    screen.getByTestId("logs-lines"),
  );
  expect(
    ["logs-follow", "logs-previous", "logs-timestamps", "logs-wrap"].map(
      (id) => switchOf(id).checked,
    ),
  ).toEqual([true, false, true, false]);
  expect(status()).toBe("Connecting");
  expect(screen.getByRole("img", { name: "Connecting" })).toBeTruthy();
});

test("a workload tab lists its Pods, and picking one reads that Pod alone", async () => {
  const b = backend();
  await show(WORKLOAD_TAB);
  await objects("deployments", [DEPLOYMENT]);
  await objects("pods", [
    pod("web-7d9f-bbbbb"),
    pod("web-7d9f-aaaaa"),
    pod("db-0", { labels: { app: "db" } }),
  ]);

  expect(await openSelect("logs-pods")).toEqual([
    "All 2 Pods",
    "web-7d9f-aaaaa",
    "web-7d9f-bbbbb",
  ]);
  await pick("web-7d9f-bbbbb");

  expect(b.callsTo("logs_stop")).toEqual([{ sessionId: "s1" }]);
  expect(b.callsTo("logs_start")[1]).toMatchObject({
    target: {
      kind: "pod",
      namespace: "shop",
      pod: "web-7d9f-bbbbb",
      container: null,
    },
  });
  expect(useDock.getState().tabs[0]).toMatchObject({
    options: { pod: "web-7d9f-bbbbb", previous: false },
  });
});

test("the Pods choice counts the Pods in en-US", () => {
  expect([0, 1, 2, 1234].map(allPodsLabel)).toEqual([
    "All Pods",
    "All 1 Pod",
    "All 2 Pods",
    "All 1,234 Pods",
  ]);
});

test("the Container choice lists every container and marks one that crash-loops", async () => {
  const b = backend();
  await show(POD_TAB);
  await objects("pods", [
    pod("web-7d9f-aaaaa", {
      init: ["setup"],
      containers: ["main", "proxy"],
      statuses: [
        {
          name: "proxy",
          restartCount: 4,
          state: { waiting: { reason: "CrashLoopBackOff" } },
        },
      ],
    }),
  ]);

  expect(await openSelect("logs-container")).toEqual([
    "All containers",
    "setup",
    "main",
    "proxy (CrashLoopBackOff)",
  ]);
  await pick("All containers");
  expect(b.callsTo("logs_start")[1]).toMatchObject({
    target: { kind: "pod", pod: "web-7d9f-aaaaa", container: null },
  });
});

test("Previous turns on only for one Pod whose container restarted, and always turns off", async () => {
  const b = backend();
  await show(POD_TAB);
  expect(switchOf("logs-previous").disabled).toBe(true);

  await objects("pods", [
    pod("web-7d9f-aaaaa", { statuses: [{ name: "main", restartCount: 0 }] }),
  ]);
  expect(switchOf("logs-previous").disabled).toBe(true);

  await objects("pods", [
    pod("web-7d9f-aaaaa", { statuses: [{ name: "main", restartCount: 2 }] }),
  ]);
  expect(switchOf("logs-previous").disabled).toBe(false);
  toggle("logs-previous");
  await act(flush);
  expect(b.callsTo("logs_start")[1]).toMatchObject({
    options: { follow: false, previous: true },
  });

  await objects("pods", [
    pod("web-7d9f-aaaaa", { statuses: [{ name: "main", restartCount: 0 }] }),
  ]);
  expect(switchOf("logs-previous").disabled).toBe(false);
  toggle("logs-previous");
  expect(switchOf("logs-previous").checked).toBe(false);
});

test("Previous stays off for all the Pods of a workload, and turns on for one of them", async () => {
  backend();
  await show(WORKLOAD_TAB);
  await objects("deployments", [DEPLOYMENT]);
  await objects("pods", [
    pod("web-7d9f-aaaaa", { statuses: [{ name: "main", restartCount: 3 }] }),
  ]);
  expect(switchOf("logs-previous").disabled).toBe(true);

  await openSelect("logs-pods");
  await pick("web-7d9f-aaaaa");
  expect(switchOf("logs-previous").disabled).toBe(false);
});

test("Lines restarts the stream with the new tail", async () => {
  const b = backend();
  await show(POD_TAB);

  expect(await openSelect("logs-lines")).toEqual([
    "Last 100 lines",
    "Last 1,000 lines",
    "All lines",
  ]);
  await pick("Last 100 lines");
  expect(b.callsTo("logs_stop")).toEqual([{ sessionId: "s1" }]);
  expect(b.callsTo("logs_start")[1]).toMatchObject({
    options: { tailLines: 100 },
  });

  await openSelect("logs-lines");
  await pick("All lines");
  expect(b.callsTo("logs_start")[2]).toMatchObject({
    options: { tailLines: null },
  });
  expect(useDock.getState().tabs[0]).toMatchObject({ options: { tail: null } });
});

test("Timestamps shows each line's timestamp as sent, and hiding it restarts nothing", async () => {
  const b = backend();
  await show(POD_TAB);
  send(lines(line("one"), line("two", { timestamp: null })));

  expect(empty()).toBeNull();
  expect(screen.getAllByTestId("log-time").map((t) => t.textContent)).toEqual([
    "2026-11-09T10:00:00.000000000Z",
  ]);
  toggle("logs-timestamps");
  expect(screen.queryAllByTestId("log-time")).toHaveLength(0);
  expect(screen.getAllByTestId("log-line").map((r) => r.textContent)).toEqual([
    "one",
    "two",
  ]);
  expect(b.callsTo("logs_start")).toHaveLength(1);
});

test("Wrap lets long lines wrap", async () => {
  backend();
  await show(POD_TAB);
  send(lines(line("a long line")));
  const text = () =>
    screen.getByTestId("log-line").lastElementChild as HTMLElement;

  expect(screen.getByTestId("logs-view").dataset.wrap).toBe("false");
  expect(getComputedStyle(text()).whiteSpace).toBe("pre");
  toggle("logs-wrap");
  expect(screen.getByTestId("logs-view").dataset.wrap).toBe("true");
  expect(getComputedStyle(text()).whiteSpace).toBe("pre-wrap");
});

test("lines of all Pods carry the Pod's suffix, colored in the order Pods appear", async () => {
  backend();
  await show(WORKLOAD_TAB);
  send(lines(line("a1"), line("b1", { pod: "web-7d9f-bbbbb" }), line("a2")));

  const prefixes = screen.getAllByTestId("log-prefix");
  expect(prefixes.map((p) => p.textContent)).toEqual([
    "aaaaa",
    "bbbbb",
    "aaaaa",
  ]);
  expect(prefixes.map((p) => p.style.color)).toEqual([
    "var(--border-accent)",
    "var(--status-nominal)",
    "var(--border-accent)",
  ]);
  expect(prefixes.map((p) => p.title)).toEqual([
    "web-7d9f-aaaaa/main",
    "web-7d9f-bbbbb/main",
    "web-7d9f-aaaaa/main",
  ]);
});

test("a workload with two containers adds the container to the prefix", async () => {
  backend();
  await show(WORKLOAD_TAB);
  await objects("deployments", [
    {
      ...DEPLOYMENT,
      spec: {
        ...DEPLOYMENT.spec,
        template: {
          spec: { containers: [{ name: "main" }, { name: "proxy" }] },
        },
      },
    },
  ]);
  send(lines(line("x", { container: "proxy" })));
  expect(screen.getByTestId("log-prefix").textContent).toBe("aaaaa proxy");
});

test("one Pod read across its containers prefixes each line with the container", async () => {
  backend();
  await show(withOptions(POD_TAB, { container: null }));
  send(lines(line("m"), line("p", { container: "proxy" })));
  expect(screen.getAllByTestId("log-prefix").map((p) => p.textContent)).toEqual(
    ["main", "proxy"],
  );
});

test("one container of one Pod has no prefix", async () => {
  backend();
  await show(POD_TAB);
  send(lines(line("m")));
  expect(screen.queryAllByTestId("log-prefix")).toHaveLength(0);
});

test("ANSI colors, the level word and markup render as text", async () => {
  backend();
  await show(POD_TAB);
  send(
    lines(
      line("\u001b[31mred\u001b[0m plain"),
      line("ERROR failed"),
      line("<script>alert(1)</script>"),
      line("long", { truncated: true }),
    ),
  );

  const rows = screen.getAllByTestId("log-line");
  expect(within(rows[0]).getByText("red").style.color).toBe(
    "var(--text-danger)",
  );
  expect(within(rows[1]).getByText("ERROR").style.color).toBe(
    "var(--text-danger)",
  );
  expect(rows[2].querySelector("script")).toBeNull();
  expect(rows[2].textContent).toContain("<script>alert(1)</script>");
  expect(rows[3].textContent).toContain("long … cut at 64 KiB");
});

test("a marker spans its row with its text", async () => {
  backend();
  await show(POD_TAB);
  send({
    type: "marker",
    pod: "web-7d9f-aaaaa",
    container: "main",
    marker: "restarted",
    message: null,
  });
  expect(screen.getByTestId("log-marker").textContent).toBe(
    "web-7d9f-aaaaa/main restarted",
  );
});

test("the empty list reads Connecting, then that the selection has no lines", async () => {
  backend();
  await show(withOptions(POD_TAB, { follow: false }));
  expect(empty()).toBe("Connecting…");
  send({ type: "ended", reason: "completed" });
  expect(empty()).toBe("No log lines for this selection.");
  expect(status()).toBe("Paused");
});

test("a Pending Pod says so, with the scheduler's message", async () => {
  const b = backend({
    resource_get: () => ({
      ...pod("web-7d9f-aaaaa"),
      status: {
        phase: "Pending",
        conditions: [
          {
            type: "PodScheduled",
            status: "False",
            reason: "Unschedulable",
            message: "0/1 nodes are available: 1 Insufficient cpu.",
          },
        ],
      },
    }),
  });
  await show(POD_TAB);
  await objects("pods", [pod("web-7d9f-aaaaa", { phase: "Pending" })]);
  await act(flush);

  expect(empty()).toBe(
    "No logs yet. The Pod is Pending. 0/1 nodes are available: 1 Insufficient cpu.",
  );
  expect(b.callsTo("resource_get")).toEqual([
    {
      clusterId: "c1",
      resource: PODS,
      namespace: "shop",
      name: "web-7d9f-aaaaa",
    },
  ]);
});

test("a failed stream shows its message with Retry, which starts again", async () => {
  const b = backend();
  await show(POD_TAB);
  send({
    type: "failed",
    error: {
      code: "Forbidden",
      message: 'pods "web-7d9f-aaaaa" is forbidden',
      details: null,
    },
  });

  const note = screen.getByTestId("logs-note");
  const message = within(note).getByText(
    'Could not read the logs: pods "web-7d9f-aaaaa" is forbidden',
  );
  expect(message.classList.contains("danger")).toBe(true);
  expect(status()).toBe("Failed");
  expect(empty()).toBeNull();

  fireEvent.click(screen.getByTestId("logs-retry"));
  await act(flush);
  expect(b.callsTo("logs_start")).toHaveLength(2);
  expect(screen.queryByTestId("logs-note")).toBeNull();
});

test("a refused start shows the backend's message", async () => {
  backend({
    logs_start: () => {
      throw {
        code: "Unreachable",
        message: "cluster c1 is not connected",
        details: null,
      };
    },
  });
  await show(POD_TAB);
  await act(flush);

  expect(
    within(screen.getByTestId("logs-note")).getByText(
      "Could not read the logs: cluster c1 is not connected",
    ),
  ).toBeTruthy();
  expect(screen.getByTestId("logs-retry")).toBeTruthy();
  expect(status()).toBe("Failed");
});

test("a Pod that is gone ends the stream with a note", async () => {
  backend();
  await show(POD_TAB);
  send(lines(line("last words")));
  send({ type: "ended", reason: "podGone" });
  expect(screen.getByTestId("logs-note").textContent).toBe("The Pod is gone.");
  expect(status()).toBe("Ended");
});
