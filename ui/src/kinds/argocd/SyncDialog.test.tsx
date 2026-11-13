import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { toast } from "../../design";
import { flush, mockBackend } from "../../test/ipc";
import type { KubeObject } from "../objects";
import { SyncDialog } from "./SyncDialog";

const APP: KubeObject = {
  metadata: { name: "web", namespace: "argocd" },
  spec: { project: "default" },
};

function open(handlers: Parameters<typeof mockBackend>[0], object = APP) {
  const backend = mockBackend(handlers);
  const close = vi.fn();
  render(<SyncDialog clusterId="c" object={object} close={close} />);
  return { backend, close };
}

const confirm = () =>
  screen.getByTestId("argocd-sync-confirm") as HTMLButtonElement;

it("sends the default options and closes with a toast", async () => {
  const success = vi.spyOn(toast, "success");
  const { backend, close } = open({ argocd_sync: () => null });
  expect(confirm().textContent).toBe("Sync");
  fireEvent.click(confirm());
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(backend.callsTo("argocd_sync")).toEqual([
    {
      clusterId: "c",
      namespace: "argocd",
      name: "web",
      options: {
        revision: null,
        prune: false,
        dryRun: false,
        force: false,
        strategy: "hook",
        syncOptions: [],
        resources: null,
        acknowledgeSyncWindows: false,
      },
    },
  ]);
  expect(success).toHaveBeenCalledWith("Sync started", "argocd/web");
});

it("names and colours the button by Prune, Dry run and Force", () => {
  open({ argocd_sync: () => null });
  fireEvent.click(screen.getByTestId("argocd-sync-prune"));
  expect(confirm().textContent).toBe("Sync and prune");
  expect(confirm().className).toMatch(/danger/);
  fireEvent.click(screen.getByTestId("argocd-sync-dry-run"));
  expect(confirm().textContent).toBe("Sync");
  expect(confirm().className).not.toMatch(/danger/);
  fireEvent.click(screen.getByTestId("argocd-sync-dry-run"));
  fireEvent.click(screen.getByTestId("argocd-sync-prune"));
  fireEvent.click(screen.getByTestId("argocd-sync-force"));
  expect(confirm().textContent).toBe("Sync");
  expect(confirm().className).toMatch(/danger/);
});

it("sends the revision, Apply only and the options it was given", async () => {
  const { backend } = open({ argocd_sync: () => null });
  fireEvent.click(screen.getByTestId("argocd-sync-apply-only"));
  fireEvent.click(screen.getByTestId("argocd-sync-dry-run"));
  fireEvent.change(screen.getByTestId("argocd-sync-revision"), {
    target: { value: " v2 " },
  });
  fireEvent.click(confirm());
  await act(flush);
  expect(backend.callsTo("argocd_sync")[0].options).toMatchObject({
    revision: "v2",
    dryRun: true,
    strategy: "apply",
  });
});

it("a blank revision is sent as null", async () => {
  const { backend } = open({ argocd_sync: () => null });
  fireEvent.change(screen.getByTestId("argocd-sync-revision"), {
    target: { value: "   " },
  });
  fireEvent.click(confirm());
  await act(flush);
  expect(backend.callsTo("argocd_sync")[0].options).toMatchObject({
    revision: null,
  });
});

it("locks the revision of a multi-source Application", () => {
  open({}, { ...APP, spec: { sources: [{ repoURL: "a" }, { repoURL: "b" }] } });
  expect(
    (screen.getByTestId("argocd-sync-revision") as HTMLInputElement).disabled,
  ).toBe(true);
  expect(
    screen.getByText(
      "This Application has several sources; each syncs at its target revision.",
    ),
  ).toBeTruthy();
});

it("shows a refusal in the dialog and keeps it open with its choices", async () => {
  const { close } = open({
    argocd_sync: () => {
      throw {
        code: "InvalidInput",
        message: "web is being deleted",
        details: null,
      };
    },
  });
  fireEvent.click(screen.getByTestId("argocd-sync-prune"));
  fireEvent.click(confirm());
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByText("web is being deleted")).toBeTruthy();
  expect(close).not.toHaveBeenCalled();
  expect(
    (screen.getByTestId("argocd-sync-prune") as HTMLInputElement).checked,
  ).toBe(true);
});

it("a Conflict without details is an ordinary error", async () => {
  open({
    argocd_sync: () => {
      throw {
        code: "Conflict",
        message: "another operation is running",
        details: null,
      };
    },
  });
  fireEvent.click(confirm());
  expect(await screen.findByText("another operation is running")).toBeTruthy();
  expect(screen.queryByTestId("argocd-windows-dialog")).toBeNull();
});

it("asks about sync windows, then syncs anyway with acknowledgement", async () => {
  const { backend, close } = open({
    argocd_sync: (a: { options: { acknowledgeSyncWindows: boolean } }) => {
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
  expect(screen.getByText("Sync windows cannot be checked")).toBeTruthy();
  fireEvent.click(screen.getByTestId("argocd-windows-confirm"));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(
    backend
      .callsTo("argocd_sync")
      .map(
        (c) =>
          (c.options as { acknowledgeSyncWindows: boolean })
            .acknowledgeSyncWindows,
      ),
  ).toEqual([false, true]);
});

it("a second click while sending sends nothing more", async () => {
  let release: () => void = () => {};
  const { backend } = open({
    argocd_sync: () =>
      new Promise<null>((resolve) => {
        release = () => resolve(null);
      }),
  });
  fireEvent.click(confirm());
  await act(flush);
  fireEvent.click(confirm());
  await act(flush);
  expect(backend.callsTo("argocd_sync")).toHaveLength(1);
  await act(async () => {
    release();
    await flush();
  });
});
