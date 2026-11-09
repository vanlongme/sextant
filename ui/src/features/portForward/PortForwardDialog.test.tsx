import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { toast } from "../../design";
import type { PortForward } from "../../ipc/generated/PortForward";
import type { KubeObject } from "../../kinds/objects";
import { flush, mockBackend } from "../../test/ipc";
import { forward } from "../../test/portForwards";
import { PortForwardDialog } from "./PortForwardDialog";
import { LOCAL_PORT_PRIVILEGED, LOCAL_PORT_RANGE } from "./ports";

afterEach(() => vi.restoreAllMocks());

const SERVICE: KubeObject = {
  metadata: { name: "web", namespace: "shop" },
  spec: {
    ports: [
      { name: "http", port: 80, protocol: "TCP" },
      { name: "dns", port: 53, protocol: "UDP" },
      { port: 8443 },
    ],
  },
};

const POD: KubeObject = {
  metadata: { name: "web-1", namespace: "shop" },
  spec: {
    initContainers: [{ name: "setup", ports: [{ containerPort: 9999 }] }],
    containers: [
      {
        name: "app",
        ports: [
          { name: "http", containerPort: 8080, protocol: "TCP" },
          { containerPort: 9090 },
        ],
      },
      {
        name: "side",
        ports: [
          { name: "metrics", containerPort: 9090 },
          { name: "syslog", containerPort: 514, protocol: "UDP" },
        ],
      },
    ],
  },
};

const UDP_ONLY: KubeObject = {
  metadata: { name: "dns", namespace: "kube-system" },
  spec: { ports: [{ name: "dns", port: 53, protocol: "UDP" }] },
};

const NOT_AVAILABLE = () => {
  throw {
    code: "InvalidInput",
    message: "local port 8080 is not available",
    details: null,
  };
};

function show(props: Partial<Parameters<typeof PortForwardDialog>[0]> = {}) {
  const close = vi.fn();
  render(
    <PortForwardDialog
      clusterId="c1"
      kind="service"
      object={SERVICE}
      close={close}
      {...props}
    />,
  );
  return close;
}

const started = (over: Partial<PortForward> = {}) =>
  forward({ id: "pf-1", state: "running", boundPort: 50123, ...over });

function backend(handlers: Parameters<typeof mockBackend>[0] = {}) {
  return mockBackend({
    portforward_add: () => forward({ id: "pf-1" }),
    portforward_start: () => started(),
    portforward_remove: () => null,
    open_external: () => null,
    ...handlers,
  });
}

const startButton = () => screen.getByTestId("pf-start") as HTMLButtonElement;
const box = () => screen.getByTestId("pf-open-browser") as HTMLInputElement;
const targetPort = () => screen.getByTestId("pf-target-port");

function typeLocal(text: string): void {
  fireEvent.change(screen.getByTestId("pf-local-port"), {
    target: { value: text },
  });
}

async function pressStart(): Promise<void> {
  fireEvent.click(startButton());
  await act(flush);
}

async function choiceLabels(): Promise<string[]> {
  fireEvent.keyDown(targetPort(), { key: "Enter" });
  return (await screen.findAllByRole("option")).map((o) => o.textContent ?? "");
}

async function choose(label: string): Promise<void> {
  fireEvent.keyDown(targetPort(), { key: "Enter" });
  fireEvent.click(await screen.findByRole("option", { name: label }));
}

test("the title and the text name a Service target", () => {
  show();
  expect(
    screen.getByRole("dialog", { name: "Port forward service/web" }),
  ).toBeTruthy();
  expect(
    screen.getByText(
      "SkoposIDE listens on 127.0.0.1 and sends each connection through the API server to a Ready Pod of the Service.",
    ),
  ).toBeTruthy();
  expect(screen.getByLabelText("Local port, empty for a random one")).toBe(
    screen.getByTestId("pf-local-port"),
  );
  expect(
    screen
      .getByRole("checkbox", { name: "Open in the browser when it starts" })
      .getAttribute("aria-describedby"),
  ).toBe(screen.getByText("Opens http://127.0.0.1 and the local port").id);
});

test("the title and the text name a Pod target", () => {
  show({ kind: "pod", object: POD });
  expect(
    screen.getByRole("dialog", { name: "Port forward pod/web-1" }),
  ).toBeTruthy();
  expect(
    screen.getByText(
      "SkoposIDE listens on 127.0.0.1 and sends each connection through the API server to this Pod.",
    ),
  ).toBeTruthy();
});

test("a Service offers its TCP ports with their names, the first chosen", async () => {
  show();
  expect(targetPort().textContent).toBe("80/TCP · http");
  expect(await choiceLabels()).toEqual(["80/TCP · http", "8443/TCP"]);
});

test("a Pod offers the TCP ports of its regular containers once each", async () => {
  show({ kind: "pod", object: POD });
  expect(await choiceLabels()).toEqual(["8080/TCP · http", "9090/TCP"]);
});

test("the port of the Forward button is chosen, and decides the browser box", () => {
  show({ port: 8443 });
  expect(targetPort().textContent).toBe("8443/TCP");
  expect(box().checked).toBe(false);
});

test.each([80, 3000, 8080, 9090, 9200])(
  "port %i ticks the browser box when the dialog opens",
  (port) => {
    show({
      object: {
        metadata: { name: "web", namespace: "shop" },
        spec: { ports: [{ port }] },
      },
    });
    expect(box().checked).toBe(true);
  },
);

test("choosing another port later leaves the browser box as it was", async () => {
  show();
  expect(box().checked).toBe(true);
  await choose("8443/TCP");
  expect(targetPort().textContent).toBe("8443/TCP");
  expect(box().checked).toBe(true);
});

test("a Service with only UDP ports asks for the target port as a number and sends what is typed", async () => {
  const calls = backend();
  show({ object: UDP_ONLY });
  const field = targetPort() as HTMLInputElement;
  expect(field.tagName).toBe("INPUT");
  expect(screen.getByLabelText("Target port")).toBe(field);
  expect(box().checked).toBe(false);
  expect(startButton().disabled).toBe(true);
  expect(screen.queryByRole("alert")).toBeNull();

  for (const bad of ["0", "65536", "1e3", "http"]) {
    fireEvent.change(field, { target: { value: bad } });
    expect(screen.getByRole("alert").textContent).toBe(
      "A port from 1 to 65535",
    );
    expect(startButton().disabled).toBe(true);
  }

  fireEvent.change(field, { target: { value: "5353" } });
  expect(screen.queryByRole("alert")).toBeNull();
  await pressStart();
  expect(calls.callsTo("portforward_add")).toEqual([
    {
      spec: {
        clusterId: "c1",
        target: { kind: "service", namespace: "kube-system", name: "dns" },
        targetPort: 5353,
        localPort: null,
      },
    },
  ]);
});

test.each<[string, number | null]>([
  ["", null],
  ["   ", null],
  [" 8080 ", 8080],
  ["08080", 8080],
  ["1024", 1024],
  ["65535", 65535],
])("a local port of %j is sent as %j", async (text, sent) => {
  const calls = backend();
  show({ port: 8443 });
  typeLocal(text);
  expect(screen.queryByRole("alert")).toBeNull();
  await pressStart();
  expect(calls.callsTo("portforward_add")).toEqual([
    {
      spec: {
        clusterId: "c1",
        target: { kind: "service", namespace: "shop", name: "web" },
        targetPort: 8443,
        localPort: sent,
      },
    },
  ]);
});

test.each(["0", "65536", "1e3", "-1", "80.5", "abc"])(
  "a local port of %j is refused with the range message",
  (text) => {
    show();
    typeLocal(text);
    expect(screen.getByRole("alert").textContent).toBe(LOCAL_PORT_RANGE);
    expect(startButton().disabled).toBe(true);
  },
);

test.each(["1", "80", "1023"])(
  "a local port of %j asks for 1024 or above",
  (text) => {
    show();
    typeLocal(text);
    expect(screen.getByRole("alert").textContent).toBe(LOCAL_PORT_PRIVILEGED);
    expect(startButton().disabled).toBe(true);
  },
);

test("Start shows a spinner and stays disabled while it runs", async () => {
  let answer: (f: PortForward) => void = () => {};
  backend({
    portforward_start: () =>
      new Promise<PortForward>((resolve) => {
        answer = resolve;
      }),
  });
  const close = show({ port: 8443 });
  await pressStart();
  expect(startButton().disabled).toBe(true);
  expect(within(startButton()).getByRole("status")).toBeTruthy();
  expect(close).not.toHaveBeenCalled();

  await act(async () => {
    answer(started());
    await flush();
  });
  expect(close).toHaveBeenCalledTimes(1);
});

test("pressing Start twice before the answer adds and starts one forward", async () => {
  let answer: (f: PortForward) => void = () => {};
  const calls = backend({
    portforward_start: () =>
      new Promise<PortForward>((resolve) => {
        answer = resolve;
      }),
  });
  const close = show({ port: 8443 });
  act(() => {
    startButton().click();
    startButton().click();
  });
  await act(flush);
  await act(async () => {
    answer(started());
    await flush();
  });
  expect(calls.callsTo("portforward_add")).toHaveLength(1);
  expect(calls.callsTo("portforward_start")).toHaveLength(1);
  expect(close).toHaveBeenCalledTimes(1);
});

test("Cancel and Escape do nothing while Start is in flight", async () => {
  let answer: (f: PortForward) => void = () => {};
  backend({
    portforward_start: () =>
      new Promise<PortForward>((resolve) => {
        answer = resolve;
      }),
  });
  const close = show({ port: 8443 });
  await pressStart();
  const cancel = screen.getByRole("button", { name: "Cancel" });
  expect((cancel as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(cancel);
  fireEvent.keyDown(screen.getByTestId("pf-dialog"), { key: "Escape" });
  await act(flush);
  expect(close).not.toHaveBeenCalled();

  await act(async () => {
    answer(started());
    await flush();
  });
  expect(close).toHaveBeenCalledTimes(1);
});

test("a failed start shows the message in the dialog and removes the new definition", async () => {
  const calls = backend({ portforward_start: NOT_AVAILABLE });
  const close = show({ port: 8443 });
  typeLocal("8080");
  await pressStart();
  const notice = screen.getByTestId("pf-error");
  expect(within(notice).getByText("Port forward failed")).toBeTruthy();
  expect(
    within(notice).getByText("local port 8080 is not available"),
  ).toBeTruthy();
  expect(calls.callsTo("portforward_remove")).toEqual([{ id: "pf-1" }]);
  expect(close).not.toHaveBeenCalled();
  expect(startButton().disabled).toBe(false);
});

test.each<[string, () => Promise<void> | void]>([
  ["the local port", () => typeLocal("8081")],
  ["the target port", () => choose("80/TCP · http")],
  ["the browser box", () => fireEvent.click(box())],
])("changing %s clears the error", async (_, change) => {
  backend({ portforward_start: NOT_AVAILABLE });
  show({ port: 8443 });
  await pressStart();
  expect(screen.getByTestId("pf-error")).toBeTruthy();
  await change();
  expect(screen.queryByTestId("pf-error")).toBeNull();
});

test("success closes the dialog, names the address and opens the browser when ticked", async () => {
  const success = vi.spyOn(toast, "success");
  const calls = backend();
  const close = show();
  await pressStart();
  expect(close).toHaveBeenCalledTimes(1);
  expect(success).toHaveBeenCalledWith(
    "Forwarding 127.0.0.1:50123",
    "to service/web:80 in shop · opening it in your browser",
  );
  expect(calls.callsTo("open_external")).toEqual([
    { url: "http://127.0.0.1:50123/" },
  ]);
});

test("success without the box ticked opens nothing", async () => {
  const success = vi.spyOn(toast, "success");
  const calls = backend();
  show({ port: 8443 });
  await pressStart();
  expect(success).toHaveBeenCalledWith(
    "Forwarding 127.0.0.1:50123",
    "to service/web:8443 in shop",
  );
  expect(calls.callsTo("open_external")).toHaveLength(0);
});

test("a Pod forward names the Pod and its port", async () => {
  const success = vi.spyOn(toast, "success");
  const calls = backend();
  show({ kind: "pod", object: POD });
  await pressStart();
  expect(calls.callsTo("portforward_add")).toEqual([
    {
      spec: {
        clusterId: "c1",
        target: { kind: "pod", namespace: "shop", name: "web-1" },
        targetPort: 8080,
        localPort: null,
      },
    },
  ]);
  expect(success).toHaveBeenCalledWith(
    "Forwarding 127.0.0.1:50123",
    "to pod/web-1:8080 in shop · opening it in your browser",
  );
});

test("a browser that does not open says so", async () => {
  const error = vi.spyOn(toast, "error");
  backend({
    open_external: () => {
      throw { code: "Internal", message: "no browser found", details: null };
    },
  });
  show();
  await pressStart();
  expect(error).toHaveBeenCalledWith(
    "Could not open the browser",
    "no browser found",
  );
});

test("an answer that is not running closes the dialog without a toast", async () => {
  const success = vi.spyOn(toast, "success");
  const calls = backend({
    portforward_start: () => forward({ id: "pf-1", state: "stopped" }),
  });
  const close = show();
  await pressStart();
  expect(close).toHaveBeenCalledTimes(1);
  expect(success).not.toHaveBeenCalled();
  expect(calls.callsTo("open_external")).toHaveLength(0);
});

test("Cancel closes the dialog and sends nothing", () => {
  const calls = backend();
  const close = show();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(close).toHaveBeenCalledTimes(1);
  expect(calls.calls).toEqual([]);
});
