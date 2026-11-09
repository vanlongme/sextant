import { expect, test } from "vitest";
import type { PortForwardSpec } from "../../ipc/generated/PortForwardSpec";
import { mockBackend } from "../../test/ipc";
import { forward } from "../../test/portForwards";
import {
  browserUrl,
  createAndStart,
  openInBrowser,
  removeMany,
  restart,
} from "./operations";

const SPEC: PortForwardSpec = {
  clusterId: "c1",
  target: { kind: "service", namespace: "shop", name: "web" },
  targetPort: 80,
  localPort: 8080,
};

const refused =
  (message: string, code = "InvalidInput") =>
  () => {
    throw { code, message, details: null };
  };

test("createAndStart adds the definition, then starts the new id", async () => {
  const backend = mockBackend({
    portforward_add: () => forward({ id: "pf-1" }),
    portforward_start: () =>
      forward({ id: "pf-1", state: "running", boundPort: 8080 }),
  });
  await expect(createAndStart(SPEC)).resolves.toMatchObject({
    id: "pf-1",
    state: "running",
    boundPort: 8080,
  });
  expect(backend.calls.map((c) => [c.cmd, c.args])).toEqual([
    ["portforward_add", { spec: SPEC }],
    ["portforward_start", { id: "pf-1" }],
  ]);
});

test("a failed start removes the new definition and rethrows the start's error", async () => {
  const backend = mockBackend({
    portforward_add: () => forward({ id: "pf-1" }),
    portforward_start: refused("local port 8080 is not available"),
    portforward_remove: refused("the store is read-only", "Internal"),
  });
  await expect(createAndStart(SPEC)).rejects.toMatchObject({
    code: "InvalidInput",
    message: "local port 8080 is not available",
  });
  expect(backend.calls.map((c) => [c.cmd, c.args])).toEqual([
    ["portforward_add", { spec: SPEC }],
    ["portforward_start", { id: "pf-1" }],
    ["portforward_remove", { id: "pf-1" }],
  ]);
});

test("a failed add starts nothing", async () => {
  const backend = mockBackend({
    portforward_add: refused('pods "web-1" is forbidden', "Forbidden"),
  });
  await expect(createAndStart(SPEC)).rejects.toMatchObject({
    code: "Forbidden",
  });
  expect(backend.calls.map((c) => c.cmd)).toEqual(["portforward_add"]);
});

test("restart stops, then starts", async () => {
  const backend = mockBackend({
    portforward_stop: () => null,
    portforward_start: () => forward({ id: "pf-1", state: "running" }),
  });
  await expect(restart("pf-1")).resolves.toMatchObject({ state: "running" });
  expect(backend.calls.map((c) => [c.cmd, c.args])).toEqual([
    ["portforward_stop", { id: "pf-1" }],
    ["portforward_start", { id: "pf-1" }],
  ]);
});

test("a restart whose stop fails does not start", async () => {
  const backend = mockBackend({
    portforward_stop: refused("stop broke", "Internal"),
  });
  await expect(restart("pf-1")).rejects.toMatchObject({
    message: "stop broke",
  });
  expect(backend.callsTo("portforward_start")).toHaveLength(0);
});

test("removeMany goes on after a failure and reports it", async () => {
  const backend = mockBackend({
    portforward_remove: (a: { id: string }) => {
      if (a.id === "b") {
        throw { code: "Internal", message: "remove broke", details: null };
      }
      return null;
    },
  });
  const failures = await removeMany(["a", "b", "c"]);
  expect(backend.callsTo("portforward_remove")).toEqual([
    { id: "a" },
    { id: "b" },
    { id: "c" },
  ]);
  expect(failures).toHaveLength(1);
  expect(failures[0]?.id).toBe("b");
  expect(failures[0]?.error).toMatchObject({ message: "remove broke" });
});

test("openInBrowser opens the bound port on 127.0.0.1", async () => {
  const backend = mockBackend({ open_external: () => null });
  await openInBrowser(
    forward({ id: "pf-1", state: "running", boundPort: 50123 }),
  );
  expect(backend.callsTo("open_external")).toEqual([
    { url: "http://127.0.0.1:50123/" },
  ]);
  expect(browserUrl(8080)).toBe("http://127.0.0.1:8080/");
});

test("openInBrowser refuses a forward that is not listening", async () => {
  const backend = mockBackend({ open_external: () => null });
  await expect(openInBrowser(forward({ id: "pf-1" }))).rejects.toThrow(
    "The port forward is not listening",
  );
  expect(backend.callsTo("open_external")).toHaveLength(0);
});
