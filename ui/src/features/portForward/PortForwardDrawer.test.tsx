import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test, vi } from "vitest";
import type { PortForward } from "../../ipc/generated/PortForward";
import { flush, mockBackend } from "../../test/ipc";
import { forward } from "../../test/portForwards";
import { PortForwardDrawer } from "./PortForwardDrawer";

afterEach(() => vi.restoreAllMocks());

const RUNNING = forward({
  id: "a",
  state: "running",
  boundPort: 50123,
  activeConnections: 3,
});
const POD = forward({
  id: "p",
  target: { kind: "pod", namespace: "shop", name: "web-1" },
  targetPort: "http",
});

const BOTH =
  "SkoposIDE binds 127.0.0.1 only, so other machines cannot use the forward. The definition stays across restarts; it does not start on its own.";

function show(f: PortForward, onClose: () => void = () => {}): void {
  render(
    <MemoryRouter>
      <PortForwardDrawer clusterId="c1" forward={f} onClose={onClose} />
    </MemoryRouter>,
  );
}

function facts(): [string, string][] {
  return Array.from(
    screen.getByTestId("pf-drawer-forward").querySelectorAll(".copyRow"),
  ).map((row) => [
    row.querySelector("dt")?.textContent ?? "",
    row.querySelector(".value")?.textContent ?? "",
  ]);
}

test("the header names the target, where it is and its status", () => {
  show(RUNNING);
  expect(
    screen.getByRole("complementary", { name: "Port forward details" }),
  ).toBe(screen.getByTestId("pf-drawer"));
  expect(screen.getByTestId("pf-drawer-title").textContent).toBe("service/web");
  expect(screen.getByText("Port forward in shop")).toBeTruthy();
  expect(screen.getByTestId("pf-drawer-status").textContent).toBe("Running");
  expect(screen.getByRole("tab", { name: "Overview" })).toBeTruthy();
});

test("the Port forward section lists the target, the ports, the address, the status and the connections", () => {
  show(RUNNING);
  expect(facts()).toEqual([
    ["Target", "service/web"],
    ["Namespace", "shop"],
    ["Target port", "80"],
    ["Local address", "127.0.0.1:50123"],
    ["Status", "Running"],
    ["Connections", "3"],
  ]);
  expect(screen.getByTestId("pf-drawer-target").getAttribute("href")).toBe(
    "/cluster/c1/r/core/services?object=shop%2Fweb",
  );
});

test("a Pod target links to the Pod, and a named port shows its name", () => {
  show(POD);
  expect(screen.getByTestId("pf-drawer-title").textContent).toBe("pod/web-1");
  expect(screen.getByTestId("pf-drawer-target").getAttribute("href")).toBe(
    "/cluster/c1/r/core/pods?object=shop%2Fweb-1",
  );
  expect(facts()[2]).toEqual(["Target port", "http"]);
});

test.each<[string, PortForward, string]>([
  [
    "a chosen port",
    forward({ id: "a", localPort: 8080 }),
    "127.0.0.1:8080 when it runs",
  ],
  ["no port", forward({ id: "a" }), "A random free port when it runs"],
])(
  "with %s and nothing bound, the address says how it will be chosen",
  (_, f, text) => {
    show(f);
    expect(facts()[3]).toEqual(["Local address", text]);
  },
);

test("a failed forward shows its message as an error", () => {
  show(
    forward({ id: "a", state: "failed", message: 'services "web" not found' }),
  );
  const notice = screen.getByTestId("pf-drawer-message");
  expect(within(notice).getByRole("alert")).toBeTruthy();
  expect(within(notice).getByText("Port forward failed")).toBeTruthy();
  expect(within(notice).getByText('services "web" not found')).toBeTruthy();
  expect(screen.queryByTestId("pf-drawer-note")).toBeNull();
});

test("another forward's message is the last connection's note", () => {
  show({ ...RUNNING, message: "connection refused by the Pod" });
  const note = screen.getByTestId("pf-drawer-note");
  expect(within(note).getByText("Last connection")).toBeTruthy();
  expect(within(note).getByText("connection refused by the Pod")).toBeTruthy();
  expect(screen.queryByTestId("pf-drawer-message")).toBeNull();
});

test("a forward without a message shows neither", () => {
  show(RUNNING);
  expect(screen.queryByTestId("pf-drawer-message")).toBeNull();
  expect(screen.queryByTestId("pf-drawer-note")).toBeNull();
});

test.each<[string, PortForward, string]>([
  [
    "Service",
    RUNNING,
    "Each new connection goes to a Ready Pod of web, so the forward survives Pod replacement.",
  ],
  [
    "Pod",
    POD,
    "Each connection goes to Pod web-1. A Pod forward ends with its Pod; forward the Service to follow replacements.",
  ],
])("How it works explains a %s forward", (_, f, first) => {
  show(f);
  const how = screen.getByTestId("pf-drawer-how");
  expect(within(how).getByText("How it works")).toBeTruthy();
  expect(
    Array.from(how.querySelectorAll("p")).map((p) => p.textContent),
  ).toEqual([first, BOTH]);
});

test("the header offers the row's actions as buttons, and they run", async () => {
  const backend = mockBackend({ portforward_stop: () => null });
  show(RUNNING);
  expect(
    within(screen.getByRole("group", { name: "Actions" }))
      .getAllByRole("button")
      .map((b) => [b.getAttribute("aria-label"), b.dataset.testid]),
  ).toEqual([
    ["Open in browser", "pf-drawer-open"],
    ["Stop", "pf-drawer-stop"],
    ["Restart", "pf-drawer-restart"],
    ["Remove", "pf-drawer-remove"],
  ]);
  fireEvent.click(screen.getByTestId("pf-drawer-stop"));
  await act(flush);
  expect(backend.callsTo("portforward_stop")).toEqual([{ id: "a" }]);
});

test("Escape and the close button close it", () => {
  const onClose = vi.fn();
  show(RUNNING, onClose);
  fireEvent.keyDown(screen.getByTestId("pf-drawer"), { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByTestId("pf-drawer-close"));
  expect(onClose).toHaveBeenCalledTimes(2);
});
