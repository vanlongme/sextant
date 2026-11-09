import { deleteTestNamespace } from "../helpers/kube";
import {
  echoPod,
  expectForwardAnswers,
  expectForwardStatus,
  forwardMenu,
  openPortForwards,
  waitForwardId,
} from "../helpers/portForward";
import { openCluster } from "../helpers/ui";

const KIND = "kind-skopos-e2e";
const NS = "skopos-test-pf-restart";

// Shares its temp HOME and config dir with port-forward-restart-1-save.e2e.ts,
// and each spec file runs in its own app process.
describe("port forwards across a restart: after", () => {
  before(async () => {
    await openCluster(KIND);
  });

  after(async () => {
    await deleteTestNamespace(NS);
  });

  it("lists the forward as Stopped without starting it, and Start makes it answer", async () => {
    await openPortForwards();
    const id = await waitForwardId("Service", "echo", NS);
    // Long enough for a start that should not happen to show.
    await browser.pause(3000);
    await expectForwardStatus(id, "Stopped", 1000);

    await forwardMenu(id, "start");
    await expectForwardStatus(id, "Running");
    await expectForwardAnswers(id, await echoPod(NS));
  });
});
