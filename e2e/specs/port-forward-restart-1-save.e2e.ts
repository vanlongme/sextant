import fs from "node:fs";
import path from "node:path";
import {
  deployEcho,
  expectForwardAnswers,
  expectForwardStatus,
  openForwardDialogOnService,
  openPortForwards,
  startInDialog,
  waitForwardId,
} from "../helpers/portForward";
import { gone, openCluster } from "../helpers/ui";

const KIND = "kind-skopos-e2e";
const NS = "skopos-test-pf-restart";

/** The saved definitions in this spec's config dir, or "" before the first save. */
function savedDefinitions(): string {
  const file = path.join(
    process.env.SKOPOS_CONFIG_DIR ?? "",
    "config",
    "portforwards.json",
  );
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

// port-forward-restart-2-verify.e2e.ts reads this definition back in a new app
// process, and deletes the namespace.
describe("port forwards across a restart: before", () => {
  let pod = "";

  before(async function () {
    this.timeout(300000);
    pod = await deployEcho(NS);
    await openCluster(KIND);
  });

  it("leaves a running Service forward whose definition is saved", async () => {
    await openForwardDialogOnService(NS);
    await startInDialog(null);
    await gone("pf-dialog");

    await openPortForwards();
    const id = await waitForwardId("Service", "echo", NS);
    await expectForwardStatus(id, "Running");
    await expectForwardAnswers(id, pod);
    await browser.waitUntil(
      () => Promise.resolve(savedDefinitions().includes(NS)),
      { timeout: 15000, timeoutMsg: "the definition was never saved" },
    );
  });
});
