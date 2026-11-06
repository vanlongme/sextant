import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { mockBackend } from "../../test/ipc";
import { DEPLOYMENTS } from "../refs";
import { ScaleDialog } from "./ScaleDialog";

function open(replicas: number | undefined, handlers = {}) {
  const backend = mockBackend({ workload_scale: () => null, ...handlers });
  const close = vi.fn();
  render(
    <ScaleDialog
      clusterId="c"
      resource={DEPLOYMENTS}
      object={{ metadata: { name: "web", namespace: "n" }, spec: { replicas } }}
      close={close}
    />,
  );
  return { backend, close };
}

test("starts at the current count and sends the new one", async () => {
  const { backend, close } = open(2);
  const input = screen.getByTestId("scale-replicas") as HTMLInputElement;
  expect(input.value).toBe("2");
  fireEvent.change(input, { target: { value: "5" } });
  fireEvent.click(screen.getByTestId("scale-confirm"));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(backend.callsTo("workload_scale")[0]).toMatchObject({
    namespace: "n",
    name: "web",
    replicas: 5,
  });
});

test.each(["", "-1", "1.5", "abc"])("refuses %j and sends nothing", (value) => {
  const { backend } = open(2);
  fireEvent.change(screen.getByTestId("scale-replicas"), { target: { value } });
  expect(
    (screen.getByTestId("scale-confirm") as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(backend.callsTo("workload_scale")).toHaveLength(0);
});

test("zero is allowed", () => {
  open(2);
  fireEvent.change(screen.getByTestId("scale-replicas"), {
    target: { value: "0" },
  });
  expect(
    (screen.getByTestId("scale-confirm") as HTMLButtonElement).disabled,
  ).toBe(false);
});

test("a failure stays in the dialog with the API's message", async () => {
  const { close } = open(2, {
    workload_scale: () => {
      throw { code: "Forbidden", message: "scale is forbidden", details: null };
    },
  });
  fireEvent.click(screen.getByTestId("scale-confirm"));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain(
      "scale is forbidden",
    ),
  );
  expect(close).not.toHaveBeenCalled();
});
