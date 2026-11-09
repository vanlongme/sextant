import { deleteTestNamespace } from "../helpers/kube";
import {
  deployEcho,
  expectAnswers,
  expectForwardAnswers,
  expectForwardStatus,
  forwardMenu,
  forwardRowIds,
  freePort,
  holdPort,
  openForwardDialogOnService,
  openPortForwards,
  startInDialog,
  waitForwardId,
} from "../helpers/portForward";
import {
  byTestId,
  clickWhenShown,
  dialogButton,
  expectConnected,
  gone,
  openCluster,
  openResource,
  resourceRowMenu,
  searchResources,
  shown,
} from "../helpers/ui";

const KIND = "kind-skopos-e2e";
const NS = "skopos-test-pf";
let pod = "";

async function expectRowCount(count: number): Promise<void> {
  let last: string[] = [];
  await browser
    .waitUntil(
      async () => {
        last = await forwardRowIds();
        return last.length === count;
      },
      { timeout: 15000 },
    )
    .catch(() => {
      throw new Error(`expected ${count} forward rows, saw ${last.join(", ")}`);
    });
}

describe("port forwarding", () => {
  before(async function () {
    this.timeout(300000);
    pod = await deployEcho(NS);
    await openCluster(KIND);
  });

  after(async () => {
    await deleteTestNamespace(NS);
  });

  it("forwards the Service's port 80 to a random port, and five requests reach the Pod", async () => {
    await openForwardDialogOnService(NS);
    await startInDialog(null);
    await gone("pf-dialog");

    await openPortForwards();
    const id = await waitForwardId("Service", "echo", NS);
    await expectForwardStatus(id, "Running");
    await expectForwardAnswers(id, pod, 5);
    expect(await (await shown("status-port-forwards")).getText()).toBe(
      "1 port forward running",
    );
  });

  it("shows the backend's message when the local port is taken, and adds no row", async () => {
    const held = await holdPort();
    try {
      await openPortForwards();
      await expectRowCount(1);

      await openForwardDialogOnService(NS);
      await startInDialog(held.port);
      const error = await shown("pf-error");
      await browser.waitUntil(
        async () =>
          (await error.getText()).includes(
            `local port ${held.port} is not available`,
          ),
        { timeout: 15000, timeoutMsg: "the dialog never named the taken port" },
      );
      await dialogButton("Cancel").click();
      await gone("pf-dialog");

      await openPortForwards();
      await expectRowCount(1);
    } finally {
      await held.close();
    }
  });

  it("stops, starts, restarts and removes a forward from its row menu", async () => {
    await openPortForwards();
    const id = await waitForwardId("Service", "echo", NS);

    await forwardMenu(id, "stop");
    await expectForwardStatus(id, "Stopped");

    await forwardMenu(id, "start");
    await expectForwardStatus(id, "Running");
    await expectForwardAnswers(id, pod);

    await forwardMenu(id, "restart");
    await expectForwardStatus(id, "Running");
    await expectForwardAnswers(id, pod);

    await forwardMenu(id, "remove");
    await gone(`pf-row-${id}`);
  });

  it("forwards a Pod's port to a fixed local port from the Port forward action", async () => {
    const local = await freePort();
    await openResource("nav-item-core-pods", "Pod");
    await searchResources(pod);
    await resourceRowMenu(pod, "portForward");
    await shown("pf-dialog");
    expect(await (await shown("pf-target-port")).getText()).toBe(
      "8080/TCP · http",
    );
    await startInDialog(local);
    await gone("pf-dialog");
    await expectAnswers(local, pod);

    await openPortForwards();
    const id = await waitForwardId("Pod", pod, NS);
    await expectForwardStatus(id, "Running");
    expect(await byTestId(`pf-local-${id}`).getText()).toBe(
      `127.0.0.1:${local}`,
    );
  });

  it("removes two selected forwards with one Remove", async () => {
    // The Pod forward of the test before, and a new Service forward.
    await openForwardDialogOnService(NS);
    await startInDialog(null);
    await gone("pf-dialog");

    await openPortForwards();
    await expectRowCount(2);
    for (const id of await forwardRowIds()) {
      await clickWhenShown(`pf-select-${id}`);
    }
    expect(await (await shown("pf-bulk-remove")).getText()).toBe("Remove (2)");
    await clickWhenShown("pf-bulk-remove");
    await shown("pf-empty");
  });

  it("shows a running forward as Stopped after Disconnect and Reconnect", async () => {
    await openForwardDialogOnService(NS);
    await startInDialog(null);
    await gone("pf-dialog");
    await openPortForwards();
    const id = await waitForwardId("Service", "echo", NS);
    await expectForwardStatus(id, "Running");

    await clickWhenShown("nav-overview");
    await clickWhenShown("cluster-disconnect");
    await browser.waitUntil(
      async () =>
        (await (await shown("connection-status")).getText()) ===
        "Disconnected",
      { timeout: 15000, timeoutMsg: "the cluster never read Disconnected" },
    );
    await clickWhenShown("cluster-reconnect");
    await expectConnected();

    await openPortForwards();
    await expectForwardStatus(id, "Stopped");
  });
});
