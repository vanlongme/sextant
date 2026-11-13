import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { toast } from "../../design";
import { mockBackend } from "../../test/ipc";
import type { KubeObject } from "../objects";
import { RollbackDialog } from "./RollbackDialog";

const HISTORY = [
  { id: 1, revision: "v1.0.0", deployedAt: "2026-11-12T10:00:00Z" },
  { id: 3, revision: "v1.2.0", deployedAt: "2026-11-14T10:00:00Z" },
  { id: 2, revision: "v1.1.0", deployedAt: "2026-11-13T10:00:00Z" },
];

function app(over: Partial<KubeObject> = {}): KubeObject {
  return {
    metadata: { name: "web", namespace: "argocd" },
    spec: {},
    status: { history: HISTORY },
    ...over,
  };
}

function open(
  object: KubeObject,
  handlers: Parameters<typeof mockBackend>[0] = {},
) {
  const backend = mockBackend(handlers);
  const close = vi.fn();
  render(<RollbackDialog clusterId="c" object={object} close={close} />);
  return { backend, close };
}

const confirm = () =>
  screen.getByTestId("argocd-rollback-confirm") as HTMLButtonElement;

it("rolls back to the newest earlier deployment by default", async () => {
  const success = vi.spyOn(toast, "success");
  const { backend, close } = open(app(), { argocd_rollback: () => null });
  expect(screen.getByText("Roll back web?")).toBeTruthy();
  expect(confirm().textContent).toBe("Roll back");
  expect(confirm().className).toMatch(/danger/);
  fireEvent.click(screen.getByTestId("argocd-rollback-prune"));
  fireEvent.click(confirm());
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(backend.callsTo("argocd_rollback")).toEqual([
    {
      clusterId: "c",
      namespace: "argocd",
      name: "web",
      options: {
        historyId: 2,
        prune: true,
        dryRun: false,
        acknowledgeSyncWindows: false,
      },
    },
  ]);
  expect(success).toHaveBeenCalledWith("Rollback started", "argocd/web");
});

it("refuses with auto-sync on", () => {
  open(app({ spec: { syncPolicy: { automated: {} } } }));
  expect(screen.getByTestId("argocd-rollback-refusal").textContent).toBe(
    "Auto-sync is on. Turn it off before rolling back.",
  );
  expect(confirm().disabled).toBe(true);
  expect(screen.queryByTestId("argocd-rollback-prune")).toBeNull();
});

it("refuses with nothing earlier to deploy", () => {
  open(app({ status: { history: [{ id: 1, revision: "a" }] } }));
  expect(screen.getByTestId("argocd-rollback-refusal").textContent).toBe(
    "There is no earlier deployment to roll back to.",
  );
  expect(confirm().disabled).toBe(true);
});

it("asks about sync windows, then rolls back anyway", async () => {
  const { backend, close } = open(app(), {
    argocd_rollback: (a: { options: { acknowledgeSyncWindows: boolean } }) => {
      if (!a.options.acknowledgeSyncWindows) {
        throw {
          code: "Conflict",
          message: "windows",
          details: "syncWindowsUnverified",
        };
      }
      return null;
    },
    resource_get: () => ({
      metadata: { name: "default", namespace: "argocd" },
      spec: {},
    }),
  });
  fireEvent.click(confirm());
  await screen.findByTestId("argocd-windows-dialog");
  const anyway = screen.getByTestId("argocd-windows-confirm");
  expect(anyway.textContent).toBe("Roll back anyway");
  fireEvent.click(anyway);
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(backend.callsTo("argocd_rollback")).toHaveLength(2);
});
