import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { toast } from "../../design";
import { mockBackend } from "../../test/ipc";
import type { KubeObject } from "../objects";
import type { ActionContext } from "../registry";
import { APPLICATION_ACTIONS } from "./actions";
import { APPLICATIONS } from "./common";

const byId = (id: string) => {
  const action = APPLICATION_ACTIONS.find((a) => a.id === id);
  if (!action) throw new Error(`no action ${id}`);
  return action;
};

function ctx(over: Partial<ActionContext> = {}): ActionContext {
  return {
    clusterId: "c",
    resource: APPLICATIONS,
    navigate: vi.fn(),
    confirm: vi.fn(),
    openEditor: vi.fn(),
    dialog: vi.fn(),
    ...over,
  };
}

const APP: KubeObject = {
  metadata: { name: "web", namespace: "argocd" },
  spec: {},
};

it("lists the five actions in order, with their access and placement", () => {
  expect(
    APPLICATION_ACTIONS.map((a) => [
      a.id,
      a.label,
      a.top ?? false,
      a.requires,
      a.danger ?? false,
    ]),
  ).toEqual([
    ["argocd-sync", "Sync", true, "update", false],
    ["argocd-refresh", "Refresh", true, "update", false],
    ["argocd-hard-refresh", "Hard refresh", false, "update", false],
    ["argocd-terminate", "Terminate", false, "update", true],
    ["argocd-rollback", "Roll back", false, "update", false],
  ]);
});

it("hides Sync and Roll back while deleting, and Terminate without an operation in progress", () => {
  const deleting = {
    ...APP,
    metadata: { ...APP.metadata, deletionTimestamp: "2026-11-14T10:00:00Z" },
  };
  for (const id of ["argocd-sync", "argocd-rollback"]) {
    expect(byId(id).visible?.(APP) ?? true).toBe(true);
    expect(byId(id).visible?.(deleting)).toBe(false);
  }
  expect(byId("argocd-refresh").visible).toBeUndefined();
  expect(byId("argocd-terminate").visible?.(APP)).toBe(false);
  expect(
    byId("argocd-terminate").visible?.({
      ...APP,
      operation: { sync: {} },
      status: { operationState: { phase: "Running" } },
    }),
  ).toBe(true);
});

it("Refresh and Hard refresh ask the backend and say so", async () => {
  const backend = mockBackend({ argocd_refresh: () => null });
  const success = vi.spyOn(toast, "success");
  await byId("argocd-refresh").run(ctx(), APP);
  await byId("argocd-hard-refresh").run(ctx(), APP);
  expect(backend.callsTo("argocd_refresh")).toEqual([
    { clusterId: "c", namespace: "argocd", name: "web", hard: false },
    { clusterId: "c", namespace: "argocd", name: "web", hard: true },
  ]);
  expect(success).toHaveBeenCalledWith("Refresh requested", "argocd/web");
  expect(success).toHaveBeenCalledWith("Hard refresh requested", "argocd/web");
});

it("Terminate asks the backend and says so; a refusal is thrown to the action runner", async () => {
  const backend = mockBackend({ argocd_terminate: () => null });
  const success = vi.spyOn(toast, "success");
  await byId("argocd-terminate").run(ctx(), APP);
  expect(backend.callsTo("argocd_terminate")).toEqual([
    { clusterId: "c", namespace: "argocd", name: "web" },
  ]);
  expect(success).toHaveBeenCalledWith("Terminate requested", "argocd/web");
  mockBackend({
    argocd_terminate: () => {
      throw {
        code: "InvalidInput",
        message: "web has no operation in progress to terminate",
        details: null,
      };
    },
  });
  await expect(byId("argocd-terminate").run(ctx(), APP)).rejects.toThrow(
    "no operation in progress",
  );
});

it("Sync and Roll back open their dialogs", () => {
  mockBackend({});
  for (const [id, testId] of [
    ["argocd-sync", "argocd-sync-dialog"],
    ["argocd-rollback", "argocd-rollback-dialog"],
  ]) {
    const dialog = vi.fn();
    byId(id).run(ctx({ dialog }), APP);
    expect(dialog).toHaveBeenCalledTimes(1);
    const render_ = dialog.mock.calls[0][0] as (close: () => void) => ReactNode;
    const { unmount } = render(<>{render_(() => {})}</>);
    expect(screen.getByTestId(testId)).toBeTruthy();
    unmount();
  }
});
