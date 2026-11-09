import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { toast } from "../../design";
import type { PortForward } from "../../ipc/generated/PortForward";
import {
  resetPortForwardsForTest,
  usePortForwards,
} from "../../stores/portForwards";
import { emitEvent, flush, mockBackend } from "../../test/ipc";
import { forward } from "../../test/portForwards";
import { mockElementSize } from "../../test/size";
import { PortForwardsScreen } from "./PortForwardsScreen";

beforeEach(() => {
  resetPortForwardsForTest();
  mockElementSize();
});
afterEach(() => vi.restoreAllMocks());

const RUNNING_A = forward({
  id: "a",
  state: "running",
  boundPort: 50123,
  activeConnections: 3,
});
const STOPPED_B = forward({
  id: "b",
  target: { kind: "pod", namespace: "shop", name: "web-1" },
  targetPort: 8080,
  localPort: 18080,
});

function Location() {
  return <span data-testid="location">{useLocation().pathname}</span>;
}

function show(): void {
  render(
    <MemoryRouter initialEntries={["/cluster/c1/port-forwards"]}>
      <PortForwardsScreen clusterId="c1" />
      <Location />
    </MemoryRouter>,
  );
}

async function loadWith(
  forwards: PortForward[],
  handlers: Parameters<typeof mockBackend>[0] = {},
) {
  const backend = mockBackend({
    portforward_list: () => forwards,
    ...handlers,
  });
  await act(async () => {
    await usePortForwards.getState().load();
  });
  return backend;
}

function rowIds(): string[] {
  return screen
    .queryAllByTestId(/^pf-row-/)
    .map((row) => (row.dataset.testid ?? "").slice("pf-row-".length));
}

function openMenu(id: string): string[] {
  fireEvent.keyDown(screen.getByTestId(`pf-menu-${id}`), { key: "Enter" });
  return screen
    .getAllByRole("menuitem")
    .map((item) => item.getAttribute("data-testid") ?? "");
}

function closeMenu(): void {
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
}

async function pick(testId: string): Promise<void> {
  fireEvent.click(screen.getByTestId(testId));
  await act(flush);
}

test("the header names the screen and counts this cluster's forwards only", async () => {
  await loadWith([RUNNING_A, STOPPED_B, forward({ id: "z", clusterId: "c2" })]);
  show();
  expect(screen.getByTestId("port-forwards-screen")).toBeTruthy();
  expect(screen.getByTestId("pf-title").textContent).toBe("Port Forwarding");
  expect(screen.getByTestId("pf-count").textContent).toBe("2");
  expect(rowIds()).toEqual(["a", "b"]);
});

test("the columns show the target, the ports, the local address, the status and the connections", async () => {
  await loadWith([RUNNING_A, STOPPED_B]);
  show();
  const table = screen.getByTestId("pf-table");
  expect(
    Array.from(table.querySelectorAll("th"))
      .map((th) => (th.textContent ?? "").replace(/[▲▼]/g, "").trim())
      .filter((text) => text !== ""),
  ).toEqual([
    "Name",
    "Namespace",
    "Kind",
    "Port",
    "Local",
    "Status",
    "Connections",
    "Actions",
  ]);
  const cells = (id: string) =>
    Array.from(screen.getByTestId(`pf-row-${id}`).querySelectorAll("td")).map(
      (td) => td.textContent,
    );
  expect(cells("a")).toEqual([
    "",
    "web",
    "shop",
    "Service",
    "80",
    "127.0.0.1:50123",
    "Running",
    "3",
    "",
  ]);
  expect(cells("b")).toEqual([
    "",
    "web-1",
    "shop",
    "Pod",
    "8080",
    "127.0.0.1:18080",
    "Stopped",
    "0",
    "",
  ]);
  expect(screen.getByTestId("pf-connections-a").textContent).toBe("3");
});

test("Local reads the bound port, else the chosen port, else random", async () => {
  await loadWith([
    forward({ id: "a", state: "running", boundPort: 50123, localPort: 8080 }),
    forward({ id: "b", localPort: 8080, targetPort: 81 }),
    forward({ id: "c", targetPort: 82 }),
  ]);
  show();
  expect(
    ["a", "b", "c"].map(
      (id) => screen.getByTestId(`pf-local-${id}`).textContent,
    ),
  ).toEqual(["127.0.0.1:50123", "127.0.0.1:8080", "random"]);
});

test.each<[PortForward["state"], string, string]>([
  ["running", "ok", "Running"],
  ["starting", "warn", "Starting"],
  ["failed", "danger", "Failed"],
  ["stopped", "neutral", "Stopped"],
])("a %s forward shows a %s dot and reads %s", async (state, tone, label) => {
  await loadWith([forward({ id: "a", state })]);
  show();
  const status = screen.getByTestId("pf-status-a");
  expect(status.textContent).toBe(label);
  expect(
    within(status).getByRole("img", { name: label }).classList.contains(tone),
  ).toBe(true);
});

test("the row menu offers what each state allows, in order", async () => {
  await loadWith([RUNNING_A, STOPPED_B]);
  show();
  expect(openMenu("a")).toEqual([
    "pf-open-a",
    "pf-stop-a",
    "pf-restart-a",
    "pf-remove-a",
  ]);
  closeMenu();
  expect(openMenu("b")).toEqual(["pf-start-b", "pf-remove-b"]);
});

test("Stop from the row menu stops the forward and says the definition stays", async () => {
  const success = vi.spyOn(toast, "success");
  const backend = await loadWith([RUNNING_A], { portforward_stop: () => null });
  show();
  openMenu("a");
  await pick("pf-stop-a");
  expect(backend.callsTo("portforward_stop")).toEqual([{ id: "a" }]);
  expect(success).toHaveBeenCalledWith(
    "Stopped the port forward",
    "The definition stays; start it again from here",
  );
});

test("Remove from the row menu asks nothing", async () => {
  const success = vi.spyOn(toast, "success");
  const backend = await loadWith([RUNNING_A], {
    portforward_remove: () => null,
  });
  show();
  openMenu("a");
  await pick("pf-remove-a");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(backend.callsTo("portforward_remove")).toEqual([{ id: "a" }]);
  expect(success).toHaveBeenCalledWith(
    "Removed the port forward",
    "Its definition is deleted",
  );
});

test("bulk Remove removes the selected rows and counts them in its toast", async () => {
  const success = vi.spyOn(toast, "success");
  const backend = await loadWith(
    [RUNNING_A, STOPPED_B, forward({ id: "c", targetPort: 9000 })],
    { portforward_remove: () => null },
  );
  show();
  const bulk = screen.getByTestId("pf-bulk-remove") as HTMLButtonElement;
  expect(bulk.disabled).toBe(true);
  expect(bulk.textContent).toBe("Remove");

  fireEvent.click(screen.getByTestId("pf-select-a"));
  fireEvent.click(screen.getByTestId("pf-select-b"));
  expect(bulk.textContent).toBe("Remove (2)");
  await pick("pf-bulk-remove");

  expect(backend.callsTo("portforward_remove")).toEqual([
    { id: "a" },
    { id: "b" },
  ]);
  expect(success).toHaveBeenCalledWith(
    "Removed 2 port forwards",
    "Their definitions are deleted",
  );
  expect(bulk.textContent).toBe("Remove");
});

test("the selection drops a row that disappears, and Remove sends only what is left", async () => {
  const success = vi.spyOn(toast, "success");
  const backend = await loadWith([RUNNING_A, STOPPED_B], {
    portforward_remove: () => null,
  });
  show();
  fireEvent.click(screen.getByTestId("pf-select-a"));
  fireEvent.click(screen.getByTestId("pf-select-b"));

  await emitEvent("portforward://changed", [RUNNING_A]);

  expect(screen.getByTestId("pf-bulk-remove").textContent).toBe("Remove (1)");
  await pick("pf-bulk-remove");
  expect(backend.callsTo("portforward_remove")).toEqual([{ id: "a" }]);
  expect(success).toHaveBeenCalledWith(
    "Removed 1 port forward",
    "Its definition is deleted",
  );
});

test("a row whose removal fails stays selected, with its own error toast", async () => {
  const error = vi.spyOn(toast, "error");
  await loadWith([RUNNING_A, STOPPED_B], {
    portforward_remove: (a: { id: string }) => {
      if (a.id === "b") {
        throw {
          code: "Internal",
          message: "store is read-only",
          details: null,
        };
      }
      return null;
    },
  });
  show();
  fireEvent.click(screen.getByTestId("pf-select-a"));
  fireEvent.click(screen.getByTestId("pf-select-b"));
  await pick("pf-bulk-remove");

  expect(error).toHaveBeenCalledWith(
    "Could not remove the port forward",
    "store is read-only",
  );
  expect(screen.getByTestId("pf-bulk-remove").textContent).toBe("Remove (1)");
  expect((screen.getByTestId("pf-select-b") as HTMLInputElement).checked).toBe(
    true,
  );
  expect((screen.getByTestId("pf-select-a") as HTMLInputElement).checked).toBe(
    false,
  );
});

test("with no forward for this cluster, the empty state leads to the Services list", async () => {
  await loadWith([forward({ id: "z", clusterId: "c2" })]);
  show();
  const empty = screen.getByTestId("pf-empty");
  expect(
    within(empty).getByText("No port forwards for this cluster"),
  ).toBeTruthy();
  expect(
    within(empty).getByText(
      "Start one from a Pod or a Service: open it and pick Port forward.",
    ),
  ).toBeTruthy();
  expect(screen.getByTestId("pf-count").textContent).toBe("0");

  await pick("pf-open-services");
  expect(screen.getByTestId("location").textContent).toBe(
    "/cluster/c1/r/core/services",
  );
});

test("the spinner shows until the list is read", () => {
  show();
  expect(
    screen.getByRole("status", { name: "Loading port forwards" }),
  ).toBeTruthy();
  expect(screen.queryByTestId("pf-count")).toBeNull();
  expect(screen.queryByTestId("pf-empty")).toBeNull();
});

test("a failed read shows the error with Retry, which reads again", async () => {
  let fail = true;
  mockBackend({
    portforward_list: () => {
      if (fail) {
        throw {
          code: "Internal",
          message: "config dir unreadable",
          details: null,
        };
      }
      return [RUNNING_A];
    },
  });
  await act(async () => {
    await usePortForwards.getState().load();
  });
  show();
  const notice = screen.getByTestId("pf-load-error");
  expect(within(notice).getByText("Could not load port forwards")).toBeTruthy();
  expect(within(notice).getByText("config dir unreadable")).toBeTruthy();

  fail = false;
  fireEvent.click(within(notice).getByRole("button", { name: "Retry" }));
  await act(flush);
  expect(screen.queryByTestId("pf-load-error")).toBeNull();
  expect(rowIds()).toEqual(["a"]);
});

test("an event replaces the rows", async () => {
  await loadWith([RUNNING_A]);
  show();
  await emitEvent("portforward://changed", [
    { ...RUNNING_A, state: "stopped", boundPort: null },
    STOPPED_B,
  ]);
  expect(rowIds()).toEqual(["a", "b"]);
  expect(screen.getByTestId("pf-status-a").textContent).toBe("Stopped");
  expect(screen.getByTestId("pf-local-a").textContent).toBe("random");
});

test("clicking a row opens its drawer, and Escape gives focus back to the row", async () => {
  await loadWith([RUNNING_A, STOPPED_B]);
  show();
  const row = screen.getByTestId("pf-row-a");
  row.focus();
  fireEvent.click(row);

  const drawer = screen.getByTestId("pf-drawer");
  expect(within(drawer).getByTestId("pf-drawer-title").textContent).toBe(
    "service/web",
  );
  expect(document.activeElement).toBe(drawer);
  expect(row.getAttribute("aria-current")).toBe("true");

  fireEvent.keyDown(drawer, { key: "Escape" });
  expect(screen.queryByTestId("pf-drawer")).toBeNull();
  expect(document.activeElement).toBe(screen.getByTestId("pf-row-a"));
});

test("the drawer follows its forward and closes when it disappears", async () => {
  await loadWith([RUNNING_A, STOPPED_B]);
  show();
  fireEvent.click(screen.getByTestId("pf-row-a"));
  expect(screen.getByTestId("pf-drawer-status").textContent).toBe("Running");

  await emitEvent("portforward://changed", [
    { ...RUNNING_A, state: "stopped", boundPort: null },
    STOPPED_B,
  ]);
  expect(screen.getByTestId("pf-drawer-status").textContent).toBe("Stopped");

  await emitEvent("portforward://changed", [STOPPED_B]);
  expect(screen.queryByTestId("pf-drawer")).toBeNull();
});

test("an item of the row menu does not open the drawer", async () => {
  await loadWith([RUNNING_A], { portforward_stop: () => null });
  show();
  openMenu("a");
  await pick("pf-stop-a");
  expect(screen.queryByTestId("pf-drawer")).toBeNull();
});
