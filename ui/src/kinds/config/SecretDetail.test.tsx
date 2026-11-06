import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { mockBackend } from "../../test/ipc";
import { SECRETS } from "../refs";
import { SecretDetail } from "./SecretDetail";

const secret = (name = "s", version = "5") => ({
  metadata: { name, namespace: "n", resourceVersion: version },
  type: "Opaque",
  data: { a: "", b: "" },
});

function show(object = secret(), handlers = {}) {
  const backend = mockBackend({
    secret_reveal: ({ key }: { key: string }) => ({
      value: `value-of-${key}`,
      binary: false,
    }),
    secret_update: () => null,
    ...handlers,
  });
  const view = render(
    <SecretDetail
      clusterId="c"
      object={object}
      resource={SECRETS}
      resources={[]}
    />,
  );
  return { backend, view };
}

test("no value is asked for until a key is revealed, and only that key", async () => {
  const { backend } = show();
  expect(backend.callsTo("secret_reveal")).toHaveLength(0);
  expect(screen.getByTestId("secret-value-a").textContent).toBe("••••••");
  fireEvent.click(screen.getByTestId("secret-reveal-a"));
  await screen.findByText("value-of-a");
  expect(backend.callsTo("secret_reveal")).toHaveLength(1);
  expect(screen.getByTestId("secret-value-b").textContent).toBe("••••••");
});

test("hiding drops the value", async () => {
  show();
  fireEvent.click(screen.getByTestId("secret-reveal-a"));
  await screen.findByText("value-of-a");
  fireEvent.click(screen.getByTestId("secret-reveal-a"));
  expect(screen.queryByText("value-of-a")).toBeNull();
});

test("a revealed value does not follow the drawer to another Secret", async () => {
  const { view } = show();
  fireEvent.click(screen.getByTestId("secret-reveal-a"));
  await screen.findByText("value-of-a");
  view.rerender(
    <SecretDetail
      clusterId="c"
      object={secret("other")}
      resource={SECRETS}
      resources={[]}
    />,
  );
  expect(screen.queryByText("value-of-a")).toBeNull();
  expect(screen.getByTestId("secret-value-a").textContent).toBe("••••••");
});

test("saving sends plain text for the changed key only and hides values again", async () => {
  const { backend } = show();
  fireEvent.click(screen.getByTestId("secret-reveal-a"));
  await screen.findByText("value-of-a");
  fireEvent.click(screen.getByTestId("secret-edit-a"));
  fireEvent.change(screen.getByTestId("secret-input-a"), {
    target: { value: "new" },
  });
  fireEvent.click(screen.getByTestId("data-save"));
  await waitFor(() => expect(backend.callsTo("secret_update")).toHaveLength(1));
  expect(backend.callsTo("secret_update")[0]).toMatchObject({
    resourceVersion: "5",
    changes: [{ key: "a", value: "new" }],
  });
  await waitFor(() =>
    expect(screen.getByTestId("secret-value-a").textContent).toBe("••••••"),
  );
});

test("a binary value is shown as such and cannot be edited", async () => {
  show(secret(), { secret_reveal: () => ({ value: "/w==", binary: true }) });
  fireEvent.click(screen.getByTestId("secret-reveal-a"));
  await screen.findByText("/w==");
  expect(screen.getByText(/binary/i)).toBeTruthy();
  expect(screen.queryByTestId("secret-edit-a")).toBeNull();
});

test("a key can be added and removed without revealing the others", async () => {
  const { backend } = show();
  fireEvent.click(screen.getByTestId("data-remove-b"));
  fireEvent.change(screen.getByTestId("data-new-key"), {
    target: { value: "c" },
  });
  fireEvent.change(screen.getByTestId("data-new-value"), {
    target: { value: "x" },
  });
  fireEvent.click(screen.getByTestId("data-add"));
  fireEvent.click(screen.getByTestId("data-save"));
  await waitFor(() => expect(backend.callsTo("secret_update")).toHaveLength(1));
  expect(backend.callsTo("secret_update")[0].changes).toEqual([
    { key: "b", value: null },
    { key: "c", value: "x" },
  ]);
  expect(backend.callsTo("secret_reveal")).toHaveLength(0);
});

test("a reveal failure shows the API's message", async () => {
  show(secret(), {
    secret_reveal: () => {
      throw { code: "Forbidden", message: "secrets is forbidden" };
    },
  });
  fireEvent.click(screen.getByTestId("secret-reveal-a"));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain(
      "secrets is forbidden",
    ),
  );
  expect(screen.getByTestId("secret-value-a").textContent).toBe("••••••");
});

test("a change on the server masks what was revealed, unless it is being edited", async () => {
  const { view } = show(secret("s", "5"));
  fireEvent.click(screen.getByTestId("secret-reveal-a"));
  await screen.findByText("value-of-a");
  view.rerender(
    <SecretDetail
      clusterId="c"
      object={secret("s", "6")}
      resource={SECRETS}
      resources={[]}
    />,
  );
  expect(screen.queryByText("value-of-a")).toBeNull();
  expect(screen.getByTestId("secret-value-a").textContent).toBe("••••••");
});

test("a conflict keeps the typed text and offers a reload", async () => {
  show(secret(), {
    secret_update: () => {
      throw {
        code: "Conflict",
        message: "the object has been modified",
        details: null,
      };
    },
  });
  fireEvent.click(screen.getByTestId("secret-reveal-a"));
  await screen.findByText("value-of-a");
  fireEvent.click(screen.getByTestId("secret-edit-a"));
  fireEvent.change(screen.getByTestId("secret-input-a"), {
    target: { value: "typed" },
  });
  fireEvent.click(screen.getByTestId("data-save"));
  await screen.findByTestId("data-conflict");
  expect(
    (screen.getByTestId("secret-input-a") as HTMLTextAreaElement).value,
  ).toBe("typed");
});

test("text being edited survives a change on the server, and reload masks it", async () => {
  const { view } = show(secret("s", "5"));
  fireEvent.click(screen.getByTestId("secret-reveal-a"));
  await screen.findByText("value-of-a");
  fireEvent.click(screen.getByTestId("secret-edit-a"));
  fireEvent.change(screen.getByTestId("secret-input-a"), {
    target: { value: "typed" },
  });
  view.rerender(
    <SecretDetail
      clusterId="c"
      object={secret("s", "6")}
      resource={SECRETS}
      resources={[]}
    />,
  );
  expect(
    (screen.getByTestId("secret-input-a") as HTMLTextAreaElement).value,
  ).toBe("typed");
  fireEvent.click(screen.getByTestId("data-reload"));
  expect(screen.queryByTestId("secret-input-a")).toBeNull();
  expect(screen.getByTestId("secret-value-a").textContent).toBe("••••••");
});

test("hiding a key being edited drops the typed text too", async () => {
  show();
  fireEvent.click(screen.getByTestId("secret-reveal-a"));
  await screen.findByText("value-of-a");
  fireEvent.click(screen.getByTestId("secret-edit-a"));
  fireEvent.change(screen.getByTestId("secret-input-a"), {
    target: { value: "typed" },
  });
  fireEvent.click(screen.getByTestId("secret-reveal-a"));
  expect(screen.queryByTestId("secret-input-a")).toBeNull();
  expect(screen.getByTestId("secret-value-a").textContent).toBe("••••••");
  expect((screen.getByTestId("data-save") as HTMLButtonElement).disabled).toBe(
    true,
  );
});

test("an answer that arrives after the key was hidden is dropped", async () => {
  let answer: (value: unknown) => void = () => {};
  const { backend } = show(secret(), {
    secret_reveal: () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  });
  fireEvent.click(screen.getByTestId("secret-reveal-a"));
  await waitFor(() => expect(backend.callsTo("secret_reveal")).toHaveLength(1));
  fireEvent.click(screen.getByTestId("secret-reveal-a"));
  answer({ value: "late", binary: false });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.queryByText("late")).toBeNull();
  expect(screen.getByTestId("secret-value-a").textContent).toBe("••••••");
});

test("an answer that arrives after a change on the server is dropped", async () => {
  let answer: (value: unknown) => void = () => {};
  const { backend, view } = show(secret("s", "5"), {
    secret_reveal: () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  });
  fireEvent.click(screen.getByTestId("secret-reveal-a"));
  await waitFor(() => expect(backend.callsTo("secret_reveal")).toHaveLength(1));
  view.rerender(
    <SecretDetail
      clusterId="c"
      object={secret("s", "6")}
      resource={SECRETS}
      resources={[]}
    />,
  );
  answer({ value: "late", binary: false });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.queryByText("late")).toBeNull();
});

test("removing a key can be undone, and does not reveal it", async () => {
  const { backend } = show();
  fireEvent.click(screen.getByTestId("data-remove-b"));
  expect(screen.queryByTestId("secret-value-b")).toBeNull();
  expect((screen.getByTestId("data-save") as HTMLButtonElement).disabled).toBe(
    false,
  );
  fireEvent.click(screen.getByTestId("data-remove-b"));
  expect(screen.getByTestId("secret-value-b").textContent).toBe("••••••");
  expect((screen.getByTestId("data-save") as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(backend.callsTo("secret_reveal")).toHaveLength(0);
});

test("a removed key cannot be added back as new", () => {
  show();
  fireEvent.click(screen.getByTestId("data-remove-b"));
  fireEvent.change(screen.getByTestId("data-new-key"), {
    target: { value: "b" },
  });
  expect((screen.getByTestId("data-add") as HTMLButtonElement).disabled).toBe(
    true,
  );
});
