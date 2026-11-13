import { act, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { IpcFailure } from "../../ipc/client";
import { flush, mockBackend } from "../../test/ipc";
import { isWindowsUnverified, SyncWindowsStep } from "./syncWindows";

it("recognises only the sync-window Conflict", () => {
  expect(
    isWindowsUnverified(
      new IpcFailure("Conflict", "x", "syncWindowsUnverified"),
    ),
  ).toBe(true);
  expect(isWindowsUnverified(new IpcFailure("Conflict", "x"))).toBe(false);
  expect(
    isWindowsUnverified(
      new IpcFailure("InvalidInput", "x", "syncWindowsUnverified"),
    ),
  ).toBe(false);
  expect(isWindowsUnverified(new Error("x"))).toBe(false);
});

it("reads the project where the controller runs and lists its windows", async () => {
  const backend = mockBackend({
    resource_get: () => ({
      metadata: { name: "team", namespace: "argo-system" },
      spec: {
        syncWindows: [{ kind: "deny", schedule: "0 22 * * *", duration: "1h" }],
      },
    }),
  });
  render(
    <SyncWindowsStep
      clusterId="c"
      action="sync"
      app={{
        metadata: { name: "web", namespace: "shop" },
        spec: { project: "team" },
        status: { controllerNamespace: "argo-system" },
      }}
    />,
  );
  await act(flush);
  expect(backend.callsTo("resource_get")[0]).toMatchObject({
    namespace: "argo-system",
    name: "team",
  });
  expect(
    screen.getByText(
      "The project team may have sync windows that block this sync. SkoposIDE cannot check them.",
    ),
  ).toBeTruthy();
  expect(screen.getByText("0 22 * * *")).toBeTruthy();
});

it("says when the project cannot be read", async () => {
  mockBackend({
    resource_get: () => {
      throw { code: "Forbidden", message: "no", details: null };
    },
  });
  render(
    <SyncWindowsStep
      clusterId="c"
      action="roll back"
      app={{ metadata: { name: "web", namespace: "shop" } }}
    />,
  );
  await act(flush);
  expect(
    screen.getByText("The project shop/default cannot be read."),
  ).toBeTruthy();
});
