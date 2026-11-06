import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { DrainEvent } from "../../ipc/generated/DrainEvent";
import { flush, mockBackend } from "../../test/ipc";
import { DrainDialog } from "./DrainDialog";

function setup(handlers = {}) {
  let send: (e: DrainEvent) => void = () => {};
  const backend = mockBackend({
    node_drain_start: (a: {
      onEvent: { onmessage: (e: DrainEvent) => void };
    }) => {
      send = a.onEvent.onmessage;
      return "drain-1";
    },
    node_drain_cancel: () => null,
    ...handlers,
  });
  const close = vi.fn();
  const view = render(<DrainDialog clusterId="c" name="n1" close={close} />);
  const emit = (e: DrainEvent) =>
    act(async () => {
      send(e);
      await flush();
    });
  const start = async () => {
    fireEvent.click(screen.getByTestId("drain-start"));
    await act(flush);
  };
  return { backend, close, view, emit, start };
}

const pod = { namespace: "n", name: "a" };
const checked = (id: string) =>
  (screen.getByTestId(id) as HTMLInputElement).checked;

test("starts with the safe options and a 5 minute timeout", async () => {
  const { backend, start } = setup();
  expect(checked("drain-force")).toBe(false);
  expect(checked("drain-empty-dir")).toBe(false);
  expect((screen.getByTestId("drain-timeout") as HTMLInputElement).value).toBe(
    "5",
  );
  await start();
  expect(backend.callsTo("node_drain_start")[0]).toMatchObject({
    clusterId: "c",
    name: "n1",
    options: { force: false, deleteEmptyDir: false, timeoutSeconds: 300 },
  });
});

test("the chosen options are sent", async () => {
  const { backend, start } = setup();
  fireEvent.click(screen.getByTestId("drain-force"));
  fireEvent.click(screen.getByTestId("drain-empty-dir"));
  fireEvent.change(screen.getByTestId("drain-timeout"), {
    target: { value: "2" },
  });
  await start();
  expect(backend.callsTo("node_drain_start")[0]).toMatchObject({
    options: { force: true, deleteEmptyDir: true, timeoutSeconds: 120 },
  });
});

test.each(["", "0", "-1", "abc", "1.5"])(
  "a timeout of %j disables Start",
  (value) => {
    setup();
    fireEvent.change(screen.getByTestId("drain-timeout"), {
      target: { value },
    });
    expect(
      (screen.getByTestId("drain-start") as HTMLButtonElement).disabled,
    ).toBe(true);
  },
);

test("shows progress per pod", async () => {
  const { emit, start } = setup();
  await start();
  await emit({ type: "cordoned" });
  await emit({ type: "planned", evict: [pod], skipped: [] });
  await emit({ type: "podBlocked", pod, message: "disruption budget" });
  expect(screen.getByTestId("drain-pod-n-a").textContent).toContain(
    "disruption budget",
  );
});

test("Cancel calls node_drain_cancel with the id", async () => {
  const { backend, start } = setup();
  await start();
  fireEvent.click(screen.getByTestId("drain-cancel"));
  await act(flush);
  expect(backend.callsTo("node_drain_cancel")).toEqual([
    { drainId: "drain-1" },
  ]);
});

test("closing the dialog cancels a running drain, once", async () => {
  const { backend, close, view, start } = setup();
  await start();
  fireEvent.keyDown(document.body, { key: "Escape" });
  await act(flush);
  expect(close).toHaveBeenCalled();
  view.unmount();
  await act(flush);
  expect(backend.callsTo("node_drain_cancel")).toEqual([
    { drainId: "drain-1" },
  ]);
});

test("leaving the screen cancels a running drain", async () => {
  const { backend, view, start } = setup();
  await start();
  view.unmount();
  await act(flush);
  expect(backend.callsTo("node_drain_cancel")).toEqual([
    { drainId: "drain-1" },
  ]);
});

test("closing the dialog after the drain finished cancels nothing", async () => {
  const { backend, close, emit, start } = setup();
  await start();
  await emit({ type: "finished", outcome: "completed", message: null });
  fireEvent.click(screen.getByTestId("drain-close"));
  await act(flush);
  expect(close).toHaveBeenCalled();
  expect(backend.callsTo("node_drain_cancel")).toEqual([]);
});

test("a refused drain says the node stays cordoned", async () => {
  const { emit, start } = setup();
  await start();
  await emit({
    type: "finished",
    outcome: "refused",
    message: "n/u has no controller",
  });
  expect(screen.getByTestId("drain-outcome").textContent).toContain(
    "n/u has no controller",
  );
  expect(screen.getByTestId("drain-still-cordoned")).toBeTruthy();
});

test("a completed drain does not offer the cordon warning", async () => {
  const { emit, start } = setup();
  await start();
  await emit({ type: "finished", outcome: "completed", message: null });
  expect(screen.queryByTestId("drain-still-cordoned")).toBeNull();
});

test("a start failure shows the API's message", async () => {
  const { start } = setup({
    node_drain_start: () => {
      throw {
        code: "Conflict",
        message: "a drain of this node is already running",
      };
    },
  });
  await start();
  expect(screen.getByRole("alert").textContent).toContain("already running");
});
