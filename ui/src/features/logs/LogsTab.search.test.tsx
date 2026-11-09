import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { LogEvent } from "../../ipc/generated/LogEvent";
import type { LogLine } from "../../ipc/generated/LogLine";
import { PODS } from "../../kinds/refs";
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

let frames: FrameRequestCallback[] = [];
let sendLog: (event: LogEvent) => void = () => {};

function backend(extra: Parameters<typeof mockBackend>[0] = {}): Backend {
  return mockBackend({
    logs_start: (a: { onEvent: { onmessage(event: LogEvent): void } }) => {
      sendLog = (event) => a.onEvent.onmessage(event);
      return "s1";
    },
    logs_stop: () => null,
    session_ack: () => null,
    resources_subscribe: () => "sub",
    resources_unsubscribe: () => null,
    ...extra,
  });
}

beforeEach(() => {
  frames = [];
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

function Live({ id }: { id: string }) {
  const tab = useDock((s) => s.tabs.find((t) => t.id === id));
  return tab?.kind === "logs" ? <LogsTab tab={tab} /> : null;
}

async function show(tab: LogsDockTab): Promise<void> {
  useDock.getState().open(tab);
  render(<Live id={tab.id} />);
  await act(flush);
}

function send(event: LogEvent): void {
  act(() => sendLog(event));
  act(() => {
    for (const run of frames.splice(0)) run(0);
  });
}

function line(text: string): LogLine {
  return {
    pod: "web-7d9f-aaaaa",
    container: "main",
    timestamp: "2026-11-09T10:00:00.000000000Z",
    text,
    truncated: false,
  };
}

function lines(...texts: string[]): LogEvent {
  return { type: "lines", lines: texts.map(line), bytes: 10 * texts.length };
}

const POD_TAB = logsTab("c1", PODS, {
  metadata: { name: "web-7d9f-aaaaa", namespace: "shop" },
  spec: { containers: [{ name: "main" }] },
});

function withOptions(
  tab: LogsDockTab,
  patch: Partial<LogTabOptions>,
): LogsDockTab {
  return { ...tab, options: { ...tab.options, ...patch } };
}

const searchBox = () => screen.getByTestId<HTMLInputElement>("logs-search");
const hits = () => screen.getByTestId("logs-hits").textContent;
const button = (id: string) => screen.getByTestId<HTMLButtonElement>(id);
const marks = () =>
  [
    ...screen
      .getByTestId("logs-view")
      .querySelectorAll<HTMLElement>("[data-mark]"),
  ].map((m) => [m.textContent, m.dataset.mark]);

async function searchFor(text: string, expected: string): Promise<void> {
  fireEvent.change(searchBox(), { target: { value: text } });
  await waitFor(() => expect(hits()).toBe(expected));
}

test("the count reads the lines, then the matches 150 ms after typing, highlighted", async () => {
  backend();
  await show(POD_TAB);
  send(lines("alpha one", "beta", "ALPHA two", "gamma"));
  expect(hits()).toBe("4 lines");
  expect(screen.getByRole("textbox", { name: "Search logs" })).toBe(
    searchBox(),
  );
  expect(searchBox().placeholder).toBe("Search logs");

  fireEvent.change(searchBox(), { target: { value: "alpha" } });
  expect(hits()).toBe("4 lines");
  await waitFor(() => expect(hits()).toBe("1 of 2"));
  expect(marks()).toEqual([
    ["alpha", "current"],
    ["ALPHA", "match"],
  ]);
});

test("Enter, Shift+Enter and the arrows step through the matches, wrapping around", async () => {
  backend();
  await show(POD_TAB);
  send(lines("alpha one", "beta", "ALPHA two", "gamma"));
  await searchFor("alpha", "1 of 2");

  fireEvent.keyDown(searchBox(), { key: "Enter" });
  expect(hits()).toBe("2 of 2");
  expect(marks()).toEqual([
    ["alpha", "match"],
    ["ALPHA", "current"],
  ]);
  fireEvent.keyDown(searchBox(), { key: "Enter" });
  expect(hits()).toBe("1 of 2");
  fireEvent.keyDown(searchBox(), { key: "Enter", shiftKey: true });
  expect(hits()).toBe("2 of 2");
  fireEvent.click(button("logs-prev-match"));
  expect(hits()).toBe("1 of 2");
  fireEvent.click(button("logs-next-match"));
  expect(hits()).toBe("2 of 2");
});

test("Enter runs a query that is still waiting for its delay", async () => {
  backend();
  await show(POD_TAB);
  send(lines("alpha one", "beta", "ALPHA two", "gamma"));
  fireEvent.change(searchBox(), { target: { value: "gamma" } });
  fireEvent.keyDown(searchBox(), { key: "Enter" });
  expect(hits()).toBe("1 of 1");
});

test("lines that arrive join the count, and the current match stays", async () => {
  backend();
  await show(POD_TAB);
  send(lines("alpha one", "beta", "ALPHA two", "gamma"));
  await searchFor("alpha", "1 of 2");
  fireEvent.keyDown(searchBox(), { key: "Enter" });
  expect(hits()).toBe("2 of 2");

  send(lines("alpha three"));
  expect(hits()).toBe("2 of 3");
});

test("one line reads 1 line, and no match turns the arrows off", async () => {
  backend();
  await show(POD_TAB);
  send(lines("only"));
  expect(hits()).toBe("1 line");
  expect(button("logs-prev-match").disabled).toBe(true);

  await searchFor("zzz", "No matches");
  expect(button("logs-prev-match").disabled).toBe(true);
  expect(button("logs-next-match").disabled).toBe(true);
});

test("Download asks where, saves all lines, and says where it saved them", async () => {
  const b = backend({
    "plugin:dialog|save": () => "/home/me/web.log",
    logs_download: () => ({ bytes: 1536 }),
  });
  await show(withOptions(POD_TAB, { previous: true, tail: 100 }));

  fireEvent.click(button("logs-download"));
  await waitFor(() =>
    expect(screen.getByTestId("logs-download-note").textContent).toBe(
      "Saved 1.5 KiB to /home/me/web.log",
    ),
  );
  expect(b.callsTo("plugin:dialog|save")).toEqual([
    {
      options: {
        defaultPath: "web-7d9f-aaaaa.log",
        filters: [{ name: "Log", extensions: ["log", "txt"] }],
      },
    },
  ]);
  expect(b.callsTo("logs_download")).toEqual([
    {
      clusterId: "c1",
      target: {
        kind: "pod",
        namespace: "shop",
        pod: "web-7d9f-aaaaa",
        container: "main",
      },
      options: {
        follow: false,
        previous: true,
        tailLines: null,
        sinceSeconds: null,
      },
      destPath: "/home/me/web.log",
    },
  ]);
  expect(screen.getByTestId("logs-note")).toBeTruthy();
});

test("Download is off while it saves", async () => {
  backend({
    "plugin:dialog|save": () => "/home/me/web.log",
    logs_download: () => new Promise(() => {}),
  });
  await show(POD_TAB);
  fireEvent.click(button("logs-download"));
  await act(flush);
  expect(button("logs-download").disabled).toBe(true);
});

test("a cancelled dialog does nothing", async () => {
  const b = backend({ "plugin:dialog|save": () => null });
  await show(POD_TAB);
  fireEvent.click(button("logs-download"));
  await act(flush);

  expect(b.callsTo("plugin:dialog|save")).toHaveLength(1);
  expect(b.callsTo("logs_download")).toEqual([]);
  expect(screen.queryByTestId("logs-note")).toBeNull();
  expect(button("logs-download").disabled).toBe(false);
});

test("a failed download says why, in the danger color", async () => {
  backend({
    "plugin:dialog|save": () => "/home/me/web.log",
    logs_download: () => {
      throw { code: "Internal", message: "disk full", details: null };
    },
  });
  await show(POD_TAB);
  fireEvent.click(button("logs-download"));

  const note = await screen.findByText(
    "Could not download the logs: disk full",
  );
  expect(note.classList.contains("danger")).toBe(true);
});
