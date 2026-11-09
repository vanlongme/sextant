import { beforeEach, expect, test } from "vitest";
import type { PortForward } from "../ipc/generated/PortForward";
import { emitEvent, flush, mockBackend } from "../test/ipc";
import { forward } from "../test/portForwards";
import {
  forwardsOf,
  resetPortForwardsForTest,
  runningCount,
  usePortForwards,
} from "./portForwards";

beforeEach(() => resetPortForwardsForTest());

const ids = () => usePortForwards.getState().forwards.map((f) => f.id);

test("load subscribes, reads the list once and keeps it", async () => {
  const backend = mockBackend({
    portforward_list: () => [forward({ id: "a" })],
  });
  await usePortForwards.getState().load();
  await usePortForwards.getState().load();
  expect(backend.callsTo("portforward_list")).toHaveLength(1);
  expect(usePortForwards.getState()).toMatchObject({
    forwards: [forward({ id: "a" })],
    loaded: true,
    error: null,
  });
});

test("an event that comes before the list's answer wins over that answer", async () => {
  let answer: (forwards: PortForward[]) => void = () => {};
  const backend = mockBackend({
    portforward_list: () =>
      new Promise<PortForward[]>((resolve) => {
        answer = resolve;
      }),
  });
  const loading = usePortForwards.getState().load();
  await flush();
  expect(backend.callsTo("portforward_list")).toHaveLength(1);

  await emitEvent("portforward://changed", [forward({ id: "new" })]);
  answer([forward({ id: "old" })]);
  await loading;

  expect(ids()).toEqual(["new"]);
  expect(usePortForwards.getState().loaded).toBe(true);
});

test("each event replaces the whole list", async () => {
  mockBackend({
    portforward_list: () => [forward({ id: "a" }), forward({ id: "b" })],
  });
  await usePortForwards.getState().load();

  await emitEvent("portforward://changed", [
    forward({ id: "c", state: "running" }),
  ]);
  expect(ids()).toEqual(["c"]);

  await emitEvent("portforward://changed", []);
  expect(ids()).toEqual([]);
});

test("a failed read sets the error, and retry reads again", async () => {
  let fail = true;
  const backend = mockBackend({
    portforward_list: () => {
      if (fail) {
        throw { code: "Internal", message: "store unreadable", details: null };
      }
      return [forward({ id: "a" })];
    },
  });
  await usePortForwards.getState().load();
  expect(usePortForwards.getState()).toMatchObject({
    loaded: false,
    error: "store unreadable",
  });

  fail = false;
  await usePortForwards.getState().retry();
  expect(backend.callsTo("portforward_list")).toHaveLength(2);
  expect(usePortForwards.getState()).toMatchObject({
    loaded: true,
    error: null,
  });
  expect(ids()).toEqual(["a"]);
});

test("an event after a failed read clears the error", async () => {
  mockBackend({
    portforward_list: () => {
      throw { code: "Internal", message: "store unreadable", details: null };
    },
  });
  await usePortForwards.getState().load();

  await emitEvent("portforward://changed", [forward({ id: "a" })]);

  expect(usePortForwards.getState()).toMatchObject({
    loaded: true,
    error: null,
  });
  expect(ids()).toEqual(["a"]);
});

test("forwardsOf keeps one cluster's forwards, by namespace, name and target port", () => {
  const list = [
    forward({ id: "1", targetPort: 8080 }),
    forward({ id: "2", clusterId: "c2" }),
    forward({
      id: "3",
      target: { kind: "pod", namespace: "audit", name: "zeta" },
    }),
    forward({ id: "4", targetPort: 443 }),
    forward({
      id: "5",
      target: { kind: "service", namespace: "shop", name: "api" },
      targetPort: 9000,
    }),
    forward({ id: "6", targetPort: "http" }),
  ];
  expect(forwardsOf(list, "c1").map((f) => f.id)).toEqual([
    "3",
    "5",
    "4",
    "1",
    "6",
  ]);
  expect(list.map((f) => f.id)).toEqual(["1", "2", "3", "4", "5", "6"]);
});

test("runningCount counts running forwards across clusters", () => {
  expect(
    runningCount([
      forward({ id: "1", state: "running" }),
      forward({ id: "2", state: "running", clusterId: "c2" }),
      forward({ id: "3", state: "starting" }),
      forward({ id: "4", state: "failed" }),
      forward({ id: "5" }),
    ]),
  ).toBe(2);
  expect(runningCount([])).toBe(0);
});
