import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { toast } from "../../design";
import { mockBackend } from "../../test/ipc";
import type { KubeObject } from "../objects";
import { kindSpec } from "../registry";
import { ApplicationDeleteDialog } from "./ApplicationDeleteDialog";
import { APPLICATIONS } from "./common";
import "./index";

const app = (name: string): KubeObject => ({
  metadata: { name, namespace: "argocd" },
});

function open(
  objects: KubeObject[],
  handlers: Parameters<typeof mockBackend>[0] = {},
) {
  const backend = mockBackend(handlers);
  const onDeleted = vi.fn();
  const onCancel = vi.fn();
  render(
    <ApplicationDeleteDialog
      clusterId="c"
      resource={APPLICATIONS}
      objects={objects}
      onCancel={onCancel}
      onDeleted={onDeleted}
    />,
  );
  return { backend, onDeleted, onCancel };
}

const confirm = () => screen.getByTestId("delete-confirm");

it("is the Applications' delete dialog", () => {
  expect(kindSpec("argoproj.io", "applications")?.deleteDialog).toBe(
    ApplicationDeleteDialog,
  );
});

it("deletes one Application with its resources by default", async () => {
  const { backend, onDeleted } = open([app("web")], {
    argocd_delete: () => null,
  });
  expect(screen.getByText("Delete Application argocd/web?")).toBeTruthy();
  expect(confirm().textContent).toBe("Delete with resources");
  fireEvent.click(confirm());
  await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(["argocd/web"]));
  expect(backend.callsTo("argocd_delete")).toEqual([
    { clusterId: "c", namespace: "argocd", name: "web", cascade: true },
  ]);
});

it("keeps the resources when asked", async () => {
  const { backend } = open([app("web")], { argocd_delete: () => null });
  fireEvent.click(screen.getByTestId("argocd-delete-cascade-keep"));
  expect(confirm().textContent).toBe("Delete the Application");
  fireEvent.click(confirm());
  await waitFor(() => expect(backend.callsTo("argocd_delete")).toHaveLength(1));
  expect(backend.callsTo("argocd_delete")[0]).toMatchObject({ cascade: false });
});

it("deletes several with one choice and names each failure", async () => {
  const error = vi.spyOn(toast, "error");
  const { backend, onDeleted } = open([app("a"), app("b"), app("c")], {
    argocd_delete: (a: { name: string }) => {
      if (a.name === "b") {
        throw {
          code: "InvalidInput",
          message: "b is already being deleted",
          details: null,
        };
      }
      return null;
    },
  });
  const dialog = screen.getByTestId("argocd-delete-dialog");
  expect(within(dialog).getByText("Delete 3 Applications?")).toBeTruthy();
  expect(within(dialog).getByText("argocd/c")).toBeTruthy();
  fireEvent.click(screen.getByTestId("argocd-delete-cascade-keep"));
  expect(confirm().textContent).toBe("Delete the Applications");
  fireEvent.click(confirm());
  await waitFor(() => expect(onDeleted).toHaveBeenCalled());
  expect(
    backend.callsTo("argocd_delete").map((c) => [c.name, c.cascade]),
  ).toEqual([
    ["a", false],
    ["b", false],
    ["c", false],
  ]);
  expect(error).toHaveBeenCalledWith(
    "Could not delete 1 of 3 Applications",
    "argocd/b: b is already being deleted",
  );
  expect(onDeleted).toHaveBeenCalledWith(["argocd/a", "argocd/c"]);
});
