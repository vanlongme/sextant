import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { resetHelmForTest } from "../../stores/helm";
import { detail, revision, runHandlers } from "../../test/helm";
import { flush, mockBackend } from "../../test/ipc";
import { RollbackDialog, UninstallDialog } from "./ReleaseDialogs";

beforeEach(() => resetHelmForTest());

const HISTORY = [
  revision({ revision: 1, chart: "nginx-1.2.2" }),
  revision({ revision: 2, chart: "nginx-1.2.3" }),
  revision({ revision: 3, chart: "nginx-1.2.4", status: "deployed" }),
];

const dialog = (id: string) => screen.getByTestId(id);
const button = (id: string, name: string) =>
  within(dialog(id)).getByRole("button", { name });

test("roll back lists every revision but the current one, newest first, and starts on the newest", async () => {
  const { started, handlers } = runHandlers();
  mockBackend({ ...handlers, helm_release_history: () => HISTORY });
  const onClose = vi.fn();
  render(
    <RollbackDialog
      clusterId="c1"
      namespace="shop"
      name="web"
      current={3}
      onClose={onClose}
    />,
  );
  expect(screen.getByText("Roll back web in shop?")).toBeTruthy();
  const select = await screen.findByTestId("helm-rollback-revision");
  expect(select.textContent).toBe("Revision 2 · nginx-1.2.3 · superseded");
  fireEvent.keyDown(select, { key: "Enter" });
  const options = await screen.findAllByRole("option");
  expect(options.map((o) => o.textContent)).toEqual([
    "Revision 2 · nginx-1.2.3 · superseded",
    "Revision 1 · nginx-1.2.2 · superseded",
  ]);
  fireEvent.click(screen.getByRole("option", { name: /Revision 1/ }));
  fireEvent.click(button("helm-rollback-dialog", "Roll back"));
  await flush();
  expect(started[0]?.args).toMatchObject({
    clusterId: "c1",
    namespace: "shop",
    release: "web",
    revision: 1,
    wait: true,
  });
  expect(onClose).toHaveBeenCalled();
});

test("roll back opens on the revision the caller names", async () => {
  mockBackend({ helm_release_history: () => HISTORY });
  render(
    <RollbackDialog
      clusterId="c1"
      namespace="shop"
      name="web"
      current={3}
      revision={1}
      onClose={() => {}}
    />,
  );
  expect(
    (await screen.findByTestId("helm-rollback-revision")).textContent,
  ).toBe("Revision 1 · nginx-1.2.2 · superseded");
});

test("a history that cannot be read shows the error with Retry, and Roll back stays disabled", async () => {
  let fail = true;
  mockBackend({
    helm_release_history: () => {
      if (fail) throw { code: "Internal", message: "timeout", details: null };
      return HISTORY;
    },
  });
  render(
    <RollbackDialog
      clusterId="c1"
      namespace="shop"
      name="web"
      current={3}
      onClose={() => {}}
    />,
  );
  expect(
    await screen.findByText("Could not read the release history"),
  ).toBeTruthy();
  expect(
    (button("helm-rollback-dialog", "Roll back") as HTMLButtonElement).disabled,
  ).toBe(true);
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByTestId("helm-rollback-revision")).toBeTruthy();
});

test("uninstall counts the objects with a ref and passes the keep-history choice", async () => {
  const { started, handlers } = runHandlers();
  const configMap = {
    group: "",
    version: "v1",
    plural: "configmaps",
    kind: "ConfigMap",
    namespaced: true,
  };
  mockBackend({
    ...handlers,
    helm_release_get: () =>
      detail({
        name: "web",
        resources: [
          {
            apiVersion: "v1",
            kind: "ConfigMap",
            namespace: "shop",
            name: "a",
            ref: configMap,
          },
          {
            apiVersion: "v1",
            kind: "ConfigMap",
            namespace: "shop",
            name: "b",
            ref: configMap,
          },
          {
            apiVersion: "x/v1",
            kind: "Gone",
            namespace: "shop",
            name: "c",
            ref: null,
          },
        ],
      }),
  });
  render(
    <UninstallDialog
      clusterId="c1"
      namespace="shop"
      name="web"
      status="deployed"
      onClose={() => {}}
    />,
  );
  expect(screen.getByText("Uninstall web from shop?")).toBeTruthy();
  expect(
    screen.getByText(
      "helm deletes the objects the release created. PersistentVolumeClaims that charts keep stay.",
    ),
  ).toBeTruthy();
  expect(
    await screen.findByText(
      "helm deletes the objects the release created (2 objects in this cluster). PersistentVolumeClaims that charts keep stay.",
    ),
  ).toBeTruthy();
  expect(
    screen.getByRole("switch", { name: "Keep the release history" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByTestId("helm-uninstall-keep-history"));
  fireEvent.click(button("helm-uninstall-dialog", "Uninstall"));
  await flush();
  expect(started[0]?.args).toMatchObject({
    release: "web",
    wait: true,
    keepHistory: true,
  });
});

test("one object reads in the singular", async () => {
  mockBackend({
    helm_release_get: () =>
      detail({
        name: "web",
        resources: [
          {
            apiVersion: "v1",
            kind: "ConfigMap",
            namespace: "shop",
            name: "a",
            ref: {
              group: "",
              version: "v1",
              plural: "configmaps",
              kind: "ConfigMap",
              namespaced: true,
            },
          },
        ],
      }),
  });
  render(
    <UninstallDialog
      clusterId="c1"
      namespace="shop"
      name="web"
      status="deployed"
      onClose={() => {}}
    />,
  );
  expect(await screen.findByText(/\(1 object in this cluster\)/)).toBeTruthy();
});

test("an uninstalled release only loses its history, with no switch", async () => {
  const { started, handlers } = runHandlers();
  const backend = mockBackend(handlers);
  render(
    <UninstallDialog
      clusterId="c1"
      namespace="shop"
      name="web"
      status="uninstalled"
      onClose={() => {}}
    />,
  );
  expect(
    screen.getByText(
      "helm deletes the history it kept for this release. Its objects are already gone.",
    ),
  ).toBeTruthy();
  expect(screen.queryByTestId("helm-uninstall-keep-history")).toBeNull();
  fireEvent.click(button("helm-uninstall-dialog", "Uninstall"));
  await flush();
  expect(backend.callsTo("helm_release_get")).toEqual([]);
  expect(started[0]?.args).toMatchObject({ keepHistory: false });
});
