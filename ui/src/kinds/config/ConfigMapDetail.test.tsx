import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { mockBackend } from "../../test/ipc";
import { CONFIGMAPS } from "../refs";
import { ConfigMapDetail } from "./ConfigMapDetail";

const map = (version = "5", a = "1") => ({
  metadata: { name: "c", namespace: "n", resourceVersion: version },
  data: { a },
  binaryData: { blob: "AA==" },
});

function show(object = map(), handlers = {}) {
  const backend = mockBackend({ configmap_update: () => null, ...handlers });
  const view = render(
    <ConfigMapDetail
      clusterId="c"
      object={object}
      resource={CONFIGMAPS}
      resources={[]}
    />,
  );
  return { backend, view };
}

const input = () =>
  screen.getByTestId("configmap-input-a") as HTMLTextAreaElement;
const type = (value: string) =>
  fireEvent.change(input(), { target: { value } });
const saveDisabled = () =>
  (screen.getByTestId("data-save") as HTMLButtonElement).disabled;

test("edits send only the change, with the version the edit started from", async () => {
  const { backend } = show();
  type("2");
  fireEvent.click(screen.getByTestId("data-save"));
  await waitFor(() =>
    expect(backend.callsTo("configmap_update")).toHaveLength(1),
  );
  expect(backend.callsTo("configmap_update")[0]).toMatchObject({
    namespace: "n",
    name: "c",
    resourceVersion: "5",
    changes: [{ key: "a", value: "2" }],
  });
});

test("save is disabled until something changed", () => {
  show();
  expect(saveDisabled()).toBe(true);
  type("2");
  expect(saveDisabled()).toBe(false);
  type("1");
  expect(saveDisabled()).toBe(true);
});

test("a live update does not overwrite an edit in progress", async () => {
  const { view } = show(map("5", "1"));
  fireEvent.change(screen.getByTestId("configmap-input-a"), {
    target: { value: "typed" },
  });
  view.rerender(
    <ConfigMapDetail
      clusterId="c"
      object={map("6", "server")}
      resource={CONFIGMAPS}
      resources={[]}
    />,
  );
  expect(
    (screen.getByTestId("configmap-input-a") as HTMLTextAreaElement).value,
  ).toBe("typed");
  expect(screen.getByTestId("data-changed-on-server")).toBeTruthy();
});

test("with no edit in progress a live update shows the new value", () => {
  const { view } = show(map("5", "1"));
  view.rerender(
    <ConfigMapDetail
      clusterId="c"
      object={map("6", "server")}
      resource={CONFIGMAPS}
      resources={[]}
    />,
  );
  expect(input().value).toBe("server");
  expect(screen.queryByTestId("data-changed-on-server")).toBeNull();
});

test("reload takes the server's value and discards the edit", () => {
  const { view } = show(map("5", "1"));
  type("typed");
  view.rerender(
    <ConfigMapDetail
      clusterId="c"
      object={map("6", "server")}
      resource={CONFIGMAPS}
      resources={[]}
    />,
  );
  fireEvent.click(screen.getByTestId("data-reload"));
  expect(input().value).toBe("server");
  expect(screen.queryByTestId("data-changed-on-server")).toBeNull();
  expect(saveDisabled()).toBe(true);
});

test("a conflict on save keeps the text and shows the notice", async () => {
  show(map(), {
    configmap_update: () => {
      throw { code: "Conflict", message: "the object has been modified" };
    },
  });
  type("typed");
  fireEvent.click(screen.getByTestId("data-save"));
  await screen.findByTestId("data-conflict");
  expect(input().value).toBe("typed");
});

test("any other failure on save keeps the text and shows the message", async () => {
  show(map(), {
    configmap_update: () => {
      throw { code: "Forbidden", message: "configmaps is forbidden" };
    },
  });
  type("typed");
  fireEvent.click(screen.getByTestId("data-save"));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain(
      "configmaps is forbidden",
    ),
  );
  expect(input().value).toBe("typed");
  expect(screen.queryByTestId("data-conflict")).toBeNull();
});

test("binary keys are listed read-only", () => {
  show();
  expect(screen.getByTestId("data-binary-blob")).toBeTruthy();
  expect(screen.queryByTestId("configmap-input-blob")).toBeNull();
});

test("an invalid new key cannot be added", () => {
  show();
  fireEvent.change(screen.getByTestId("data-new-key"), {
    target: { value: "a b" },
  });
  expect((screen.getByTestId("data-add") as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(screen.getByRole("alert").textContent).toContain("letters, digits");
});

test("a key that already exists cannot be added again", () => {
  show();
  fireEvent.change(screen.getByTestId("data-new-key"), {
    target: { value: "a" },
  });
  expect((screen.getByTestId("data-add") as HTMLButtonElement).disabled).toBe(
    true,
  );
});

test("a key held in binaryData cannot be added", () => {
  show();
  fireEvent.change(screen.getByTestId("data-new-key"), {
    target: { value: "blob" },
  });
  expect((screen.getByTestId("data-add") as HTMLButtonElement).disabled).toBe(
    true,
  );
});

test("a saved value stays on screen until the live object catches up", async () => {
  const { backend, view } = show(map("5", "1"));
  type("2");
  fireEvent.click(screen.getByTestId("data-save"));
  await waitFor(() =>
    expect(backend.callsTo("configmap_update")).toHaveLength(1),
  );
  await waitFor(() => expect(saveDisabled()).toBe(true));
  expect(input().value).toBe("2");
  view.rerender(
    <ConfigMapDetail
      clusterId="c"
      object={map("6", "2")}
      resource={CONFIGMAPS}
      resources={[]}
    />,
  );
  expect(input().value).toBe("2");
  expect(screen.queryByTestId("data-changed-on-server")).toBeNull();
});
