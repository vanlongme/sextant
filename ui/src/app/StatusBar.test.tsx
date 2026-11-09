import { act, render, screen } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import type { PortForward } from "../ipc/generated/PortForward";
import { resetCatalogForTest } from "../stores/catalog";
import {
  resetPortForwardsForTest,
  usePortForwards,
} from "../stores/portForwards";
import { flush, mockBackend } from "../test/ipc";
import { forward } from "../test/portForwards";
import { StatusBar } from "./StatusBar";

beforeEach(() => {
  resetCatalogForTest();
  resetPortForwardsForTest();
  mockBackend({});
});

async function show(forwards: PortForward[]): Promise<void> {
  usePortForwards.setState({ forwards, loaded: true });
  render(<StatusBar />);
  await act(flush);
}

test.each<[string, PortForward[], string | null]>([
  [
    "none running",
    [forward({ id: "a" }), forward({ id: "b", state: "starting" })],
    null,
  ],
  [
    "one running",
    [
      forward({ id: "a", state: "running" }),
      forward({ id: "b", state: "failed" }),
    ],
    "1 port forward running",
  ],
  [
    "two running in two clusters",
    [
      forward({ id: "a", state: "running" }),
      forward({ id: "b", state: "running", clusterId: "c2" }),
    ],
    "2 port forwards running",
  ],
])("with %s, the status bar reads %j", async (_, forwards, text) => {
  await show(forwards);
  const item = screen.queryByTestId("status-port-forwards");
  if (text === null) expect(item).toBeNull();
  else expect(item?.textContent).toBe(text);
});

test("the count sits between the connected count and the version", async () => {
  await show([forward({ id: "a", state: "running" })]);
  expect(
    Array.from(screen.getByTestId("status-bar").children).map(
      (child) => child.textContent,
    ),
  ).toEqual(["0 connected", "1 port forward running", "SkoposIDE 0.1.0"]);
});

test("the count follows the store", async () => {
  await show([forward({ id: "a", state: "running" })]);
  act(() => usePortForwards.setState({ forwards: [forward({ id: "a" })] }));
  expect(screen.queryByTestId("status-port-forwards")).toBeNull();
});
