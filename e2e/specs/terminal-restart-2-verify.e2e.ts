import { kubectl } from "../helpers/kube";
import {
  dialogButton, dockTabTitles, expectTerminalLine, expectTerminalStatus, inDockPanel,
  openCluster, terminalRows, terminalStatus, typeInTerminal,
} from "../helpers/ui";

const KIND = "kind-skopos-e2e";
const WORKER = "skopos-e2e-worker";
const NODE_SHELL_PODS = [
  "-n", "kube-system", "get", "pods", "-l", "skopos.dev/node-shell=true", "-o", "name",
];
const until = (check: () => Promise<boolean>, timeoutMsg: string, timeout = 60000) =>
  browser.waitUntil(check, { timeout, interval: 500, timeoutMsg });

async function nodeShellPods(): Promise<string> {
  return (await kubectl(NODE_SHELL_PODS)).trim();
}

// Shares its temp HOME and config dir with terminal-restart-1-save.e2e.ts, and
// each spec file runs in its own app process.
describe("terminal tabs across a restart: after", () => {
  before(async () => {
    await openCluster(KIND);
  });

  after(async () => {
    await kubectl([
      "-n", "kube-system", "delete", "pod", "-l", "skopos.dev/node-shell=true", "--ignore-not-found",
    ]);
  });

  it("restores both tabs, and the Node shell reads Not connected without starting", async () => {
    await until(
      async () =>
        JSON.stringify(await dockTabTitles()) ===
        JSON.stringify([`Terminal · ${KIND}`, `Shell · ${WORKER}`]),
      "the dock never restored the two tabs",
    );
    expect(
      await browser.$('[data-testid^="dock-tab-node-shell:"]').getAttribute("aria-selected"),
    ).toBe("true");
    // Long enough for a start that should not happen to show.
    await browser.pause(3000);
    expect(await terminalStatus()).toBe("Not connected");
    expect(
      await browser.execute(
        () =>
          document.querySelector('[data-testid^="dock-panel-terminal:"] [data-testid="terminal-status"]')
            ?.textContent ?? null,
      ),
    ).toBe("Not connected");
    expect(await nodeShellPods()).toBe("");
  });

  it("starts a new local shell when the Terminal tab is shown", async () => {
    await browser.$('[data-testid^="dock-tab-terminal:"]').click();
    await expectTerminalStatus("Local shell");
    expect((await terminalRows()).some((row) => row.includes("before-restart"))).toBe(false);
    await typeInTerminal("echo after-restart-$((3+4))");
    await expectTerminalLine("after-restart-7");
  });

  it("starts the Node shell after Reconnect and its confirmation", async function () {
    this.timeout(420000);
    await browser.$('[data-testid^="dock-tab-node-shell:"]').click();
    await inDockPanel("terminal-reconnect").click();
    await dialogButton("Open shell").waitForExist({ timeout: 15000 });
    await dialogButton("Open shell").click();
    await expectTerminalStatus("Connected", 240000);
    await typeInTerminal("echo host-$(cat /etc/hostname)");
    await expectTerminalLine(`host-${WORKER}`);

    await browser.$('[data-testid^="dock-close-node-shell:"]').click();
    await until(async () => (await nodeShellPods()) === "", "the node shell Pod was never deleted", 120000);
  });
});
