import { ExternalLink, Play, RotateCw, Square, Trash2 } from "lucide-react";
import { afterEach, expect, test, vi } from "vitest";
import { toast } from "../../design";
import type { PortForward } from "../../ipc/generated/PortForward";
import { mockBackend } from "../../test/ipc";
import { forward } from "../../test/portForwards";
import {
  type ForwardActionId,
  forwardActions,
  removeForwards,
} from "./forwardActions";

afterEach(() => vi.restoreAllMocks());

const RUNNING = forward({ id: "a", state: "running", boundPort: 50123 });

const refused =
  (message: string, code = "Internal") =>
  () => {
    throw { code, message, details: null };
  };

function action(f: PortForward, id: ForwardActionId) {
  const found = forwardActions(f).find((a) => a.id === id);
  if (!found) throw new Error(`no ${id} action`);
  return found;
}

test.each<[string, PortForward, ForwardActionId[]]>([
  ["running with a bound port", RUNNING, ["open", "stop", "restart", "remove"]],
  [
    "running without a bound port",
    forward({ id: "a", state: "running" }),
    ["stop", "restart", "remove"],
  ],
  ["starting", forward({ id: "a", state: "starting" }), ["stop", "remove"]],
  ["stopped", forward({ id: "a" }), ["start", "remove"]],
  [
    "failed",
    forward({ id: "a", state: "failed", message: "boom" }),
    ["start", "remove"],
  ],
])("a forward %s offers %j", (_, f, ids) => {
  expect(forwardActions(f).map((a) => a.id)).toEqual(ids);
});

test("labels, icons and the one dangerous action", () => {
  expect(
    forwardActions(RUNNING).map((a) => [a.label, a.icon, a.danger]),
  ).toEqual([
    ["Open in browser", ExternalLink, false],
    ["Stop", Square, false],
    ["Restart", RotateCw, false],
    ["Remove", Trash2, true],
  ]);
  expect(action(forward({ id: "a" }), "start")).toMatchObject({
    label: "Start",
    icon: Play,
    danger: false,
  });
});

test("Open in browser opens the bound port", async () => {
  const backend = mockBackend({ open_external: () => null });
  await action(RUNNING, "open").run();
  expect(backend.callsTo("open_external")).toEqual([
    { url: "http://127.0.0.1:50123/" },
  ]);
});

test("Start starts, with no toast of its own", async () => {
  const success = vi.spyOn(toast, "success");
  const backend = mockBackend({
    portforward_start: () => forward({ id: "a", state: "running" }),
  });
  await action(forward({ id: "a" }), "start").run();
  expect(backend.callsTo("portforward_start")).toEqual([{ id: "a" }]);
  expect(success).not.toHaveBeenCalled();
});

test("Stop stops and says the definition stays", async () => {
  const success = vi.spyOn(toast, "success");
  const backend = mockBackend({ portforward_stop: () => null });
  await action(RUNNING, "stop").run();
  expect(backend.callsTo("portforward_stop")).toEqual([{ id: "a" }]);
  expect(success).toHaveBeenCalledWith(
    "Stopped the port forward",
    "The definition stays; start it again from here",
  );
});

test("Restart stops, then starts", async () => {
  const backend = mockBackend({
    portforward_stop: () => null,
    portforward_start: () => RUNNING,
  });
  await action(RUNNING, "restart").run();
  expect(backend.calls.map((c) => [c.cmd, c.args])).toEqual([
    ["portforward_stop", { id: "a" }],
    ["portforward_start", { id: "a" }],
  ]);
});

test("Remove asks nothing and says the definition is deleted", async () => {
  const success = vi.spyOn(toast, "success");
  const backend = mockBackend({ portforward_remove: () => null });
  await action(RUNNING, "remove").run();
  expect(backend.callsTo("portforward_remove")).toEqual([{ id: "a" }]);
  expect(success).toHaveBeenCalledWith(
    "Removed the port forward",
    "Its definition is deleted",
  );
});

const NOT_CONNECTED = "cluster c1 is not connected";
const DELETED = 'services "web" not found';

test.each<[ForwardActionId, string, PortForward, string]>([
  ["start", "Unreachable", forward({ id: "a" }), NOT_CONNECTED],
  ["start", "NotFound", forward({ id: "a", state: "failed" }), DELETED],
  ["restart", "Unreachable", RUNNING, NOT_CONNECTED],
  ["restart", "NotFound", RUNNING, DELETED],
])(
  "%s that the backend refuses with %s shows its message and nothing else",
  async (id, code, f, message) => {
    const success = vi.spyOn(toast, "success");
    const error = vi.spyOn(toast, "error");
    mockBackend({
      portforward_stop: () => null,
      portforward_start: refused(message, code),
    });
    await expect(action(f, id).run()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith("Port forward failed", message);
    expect(success).not.toHaveBeenCalled();
  },
);

test.each<[ForwardActionId, string, string]>([
  ["stop", "portforward_stop", "Could not stop the port forward"],
  ["remove", "portforward_remove", "Could not remove the port forward"],
  ["open", "open_external", "Could not open the browser"],
])(
  "a failed %s shows %s's message under its own title",
  async (id, cmd, title) => {
    const success = vi.spyOn(toast, "success");
    const error = vi.spyOn(toast, "error");
    mockBackend({ [cmd]: refused("it broke") });
    await expect(action(RUNNING, id).run()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(title, "it broke");
    expect(success).not.toHaveBeenCalled();
  },
);

test("removeForwards toasts each failure and counts the rest", async () => {
  const success = vi.spyOn(toast, "success");
  const error = vi.spyOn(toast, "error");
  mockBackend({
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
  await expect(removeForwards(["a", "b", "c"])).resolves.toEqual(["b"]);
  expect(error).toHaveBeenCalledTimes(1);
  expect(error).toHaveBeenCalledWith(
    "Could not remove the port forward",
    "store is read-only",
  );
  expect(success).toHaveBeenCalledWith(
    "Removed 2 port forwards",
    "Their definitions are deleted",
  );
});

test("removeForwards of one says so in the singular", async () => {
  const success = vi.spyOn(toast, "success");
  mockBackend({ portforward_remove: () => null });
  await expect(removeForwards(["a"])).resolves.toEqual([]);
  expect(success).toHaveBeenCalledWith(
    "Removed 1 port forward",
    "Its definition is deleted",
  );
});

test("removeForwards that removes nothing shows only the errors", async () => {
  const success = vi.spyOn(toast, "success");
  const error = vi.spyOn(toast, "error");
  mockBackend({ portforward_remove: refused("store is read-only") });
  await expect(removeForwards(["a", "b"])).resolves.toEqual(["a", "b"]);
  expect(error).toHaveBeenCalledTimes(2);
  expect(success).not.toHaveBeenCalled();
});
