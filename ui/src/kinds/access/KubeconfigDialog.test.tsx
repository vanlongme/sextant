import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { toast } from "../../design";
import { flush, mockBackend } from "../../test/ipc";
import type { KubeObject } from "../objects";
import { type ActionContext, kindSpec } from "../registry";
import { saveKubeconfigAction } from "./actions";
import "./index";
import { KubeconfigDialog } from "./KubeconfigDialog";

afterEach(() => vi.restoreAllMocks());

const SA: KubeObject = { metadata: { name: "robot", namespace: "ci" } };
const EXPIRES = "2026-11-08T13:00:00Z";
const PATH = "/home/me/robot.kubeconfig";

function show(handlers: Parameters<typeof mockBackend>[0]) {
  const backend = mockBackend(handlers);
  const close = vi.fn();
  render(<KubeconfigDialog clusterId="c" object={SA} close={close} />);
  return { backend, close };
}

const saved = () => ({ expiresAt: EXPIRES });

test("the dialog explains the token and saves a one-hour token by default", async () => {
  const success = vi.spyOn(toast, "success");
  const { backend, close } = show({
    "plugin:dialog|save": () => PATH,
    service_account_kubeconfig_save: saved,
  });
  expect(
    screen.getByRole("dialog", { name: "Save a kubeconfig for robot" }),
  ).toBeTruthy();
  expect(
    screen.getByText(
      "The file holds a token from the TokenRequest API. Anyone with it acts as this ServiceAccount until the token expires.",
    ),
  ).toBeTruthy();
  fireEvent.click(screen.getByTestId("kubeconfig-save"));
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  expect(backend.callsTo("plugin:dialog|save")[0]).toMatchObject({
    options: {
      defaultPath: "robot.kubeconfig",
      filters: [{ extensions: ["kubeconfig", "yaml"] }],
    },
  });
  expect(backend.callsTo("service_account_kubeconfig_save")[0]).toMatchObject({
    clusterId: "c",
    namespace: "ci",
    name: "robot",
    destPath: PATH,
    expirationSeconds: 3600,
  });
  expect(success).toHaveBeenCalledWith(
    `Saved the kubeconfig · token expires ${new Date(EXPIRES).toLocaleString()}`,
  );
});

test.each([
  ["8 hours", 28800],
  ["24 hours", 86400],
])("choosing %s asks for %i seconds", async (label, seconds) => {
  const { backend, close } = show({
    "plugin:dialog|save": () => PATH,
    service_account_kubeconfig_save: saved,
  });
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Token lifetime" }), {
    key: "Enter",
  });
  fireEvent.click(await screen.findByRole("option", { name: label }));
  fireEvent.click(screen.getByTestId("kubeconfig-save"));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(backend.callsTo("service_account_kubeconfig_save")[0]).toMatchObject({
    expirationSeconds: seconds,
  });
});

test("a cancelled file dialog keeps the dialog open and saves nothing", async () => {
  const { backend, close } = show({
    "plugin:dialog|save": () => null,
    service_account_kubeconfig_save: saved,
  });
  fireEvent.click(screen.getByTestId("kubeconfig-save"));
  await act(flush);
  expect(close).not.toHaveBeenCalled();
  expect(backend.callsTo("service_account_kubeconfig_save")).toHaveLength(0);
  expect(
    (screen.getByTestId("kubeconfig-save") as HTMLButtonElement).disabled,
  ).toBe(false);
});

test("a refused save shows the server's message inside the dialog", async () => {
  const { close } = show({
    "plugin:dialog|save": () => PATH,
    service_account_kubeconfig_save: () => {
      throw {
        code: "Forbidden",
        message: 'serviceaccounts "robot" token is forbidden',
        details: null,
      };
    },
  });
  fireEvent.click(screen.getByTestId("kubeconfig-save"));
  expect(
    await screen.findByText('serviceaccounts "robot" token is forbidden'),
  ).toBeTruthy();
  expect(screen.getByText("Could not save the kubeconfig")).toBeTruthy();
  expect(close).not.toHaveBeenCalled();
});

test("a failing file dialog shows its error and lets Save be pressed again", async () => {
  const { close } = show({
    "plugin:dialog|save": () => {
      throw new Error("no portal for the file dialog");
    },
    service_account_kubeconfig_save: saved,
  });
  fireEvent.click(screen.getByTestId("kubeconfig-save"));
  expect(await screen.findByText(/no portal for the file dialog/)).toBeTruthy();
  expect(
    (screen.getByTestId("kubeconfig-save") as HTMLButtonElement).disabled,
  ).toBe(false);
  expect(close).not.toHaveBeenCalled();
});

test("pressing Save twice while saving saves once", async () => {
  const { backend } = show({
    "plugin:dialog|save": () => PATH,
    service_account_kubeconfig_save: () => new Promise(() => {}),
  });
  const button = screen.getByTestId("kubeconfig-save");
  fireEvent.click(button);
  fireEvent.click(button);
  await act(flush);
  fireEvent.click(button);
  await act(flush);
  expect(backend.callsTo("plugin:dialog|save")).toHaveLength(1);
  expect(backend.callsTo("service_account_kubeconfig_save")).toHaveLength(1);
});

test("the ServiceAccount action opens the dialog through the context", () => {
  mockBackend({});
  let opened: ReactNode = null;
  const ctx: ActionContext = {
    clusterId: "c",
    resource: {
      group: "",
      version: "v1",
      plural: "serviceaccounts",
      kind: "ServiceAccount",
      namespaced: true,
    },
    navigate: () => {},
    confirm: async () => true,
    openEditor: () => {},
    dialog: (render) => {
      opened = render(() => {});
    },
  };
  void saveKubeconfigAction.run(ctx, SA);
  render(<>{opened}</>);
  expect(
    screen.getByRole("dialog", { name: "Save a kubeconfig for robot" }),
  ).toBeTruthy();
  expect(
    kindSpec("", "serviceaccounts")?.actions?.map((a) => [a.id, a.label]),
  ).toEqual([["kubeconfig", "Save kubeconfig with a token"]]);
});
