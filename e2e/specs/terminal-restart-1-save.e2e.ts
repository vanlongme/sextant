import fs from "node:fs";
import path from "node:path";
import {
  clickWhenShown, dialogButton, dockTabTitles, expectTerminalLine, expectTerminalStatus,
  openCluster, requestNodeShell, terminalStatus, typeInTerminal,
} from "../helpers/ui";

const KIND = "kind-skopos-e2e";
const WORKER = "skopos-e2e-worker";
const until = (check: () => Promise<boolean>, timeoutMsg: string) =>
  browser.waitUntil(check, { timeout: 60000, interval: 500, timeoutMsg });

interface SavedLayout {
  activeId: string | null;
  tabs: { kind: string }[];
}

/** The dock layout as the app saved it in this spec's config dir, or null. */
function savedLayout(): SavedLayout | null {
  const file = path.join(process.env.SKOPOS_CONFIG_DIR ?? "", "config", "ui-state.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")).data?.["dock:layout"] ?? null;
  } catch {
    return null;
  }
}

// terminal-restart-2-verify.e2e.ts reads this layout back in a new app process.
describe("terminal tabs across a restart: before", () => {
  before(async () => {
    await openCluster(KIND);
  });

  it("leaves a used Terminal tab and an ended Node shell tab, the node shell active", async function () {
    this.timeout(420000);
    await clickWhenShown("dock-terminal");
    await expectTerminalStatus("Local shell");
    await typeInTerminal("echo before-restart-$((2+3))");
    await expectTerminalLine("before-restart-5");

    await requestNodeShell(WORKER);
    await dialogButton("Open shell").click();
    await expectTerminalStatus("Connected", 240000);
    // An ended node shell leaves no Pod behind for the next app.
    await typeInTerminal("exit");
    await until(async () => (await terminalStatus()).startsWith("Exited"), "the node shell never ended");

    await until(
      async () =>
        JSON.stringify(await dockTabTitles()) ===
        JSON.stringify([`Terminal · ${KIND}`, `Shell · ${WORKER}`]),
      "the dock never held the two tabs",
    );
    await until(() => {
      const layout = savedLayout();
      return Promise.resolve(
        JSON.stringify(layout?.tabs.map((t) => t.kind)) === JSON.stringify(["terminal", "nodeShell"]) &&
          (layout?.activeId ?? "").startsWith("node-shell:"),
      );
    }, "the layout with the two tabs was never saved");
  });
});
