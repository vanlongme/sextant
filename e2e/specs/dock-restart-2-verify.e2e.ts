import { deleteTestNamespace } from "../helpers/kube";
import { byTestId, dockTabTitles, openCluster } from "../helpers/ui";

const KIND = "kind-skopos-e2e";
const NS = "skopos-test-dock-restart";
const until = (check: () => Promise<boolean>, timeoutMsg: string) =>
  browser.waitUntil(check, { timeout: 60000, interval: 500, timeoutMsg });

// Shares its temp HOME and config dir with dock-restart-1-save.e2e.ts, and
// each spec file runs in its own app process.
describe("the dock layout across a restart: after", () => {
  before(async () => {
    await openCluster(KIND);
  });

  after(async () => {
    await deleteTestNamespace(NS);
  });

  it("restores the height, the tab order, the active tab and the Logs tab's options", async () => {
    await until(
      async () => JSON.stringify(await dockTabTitles()) === JSON.stringify(["Create", "Logs · keeper"]),
      "the dock never restored its tabs in their order",
    );
    expect(await browser.$('[data-testid^="dock-tab-logs:"]').getAttribute("aria-selected")).toBe("true");
    expect(
      await browser.execute(() => document.querySelector<HTMLElement>('[data-testid="dock"]')?.style.height),
    ).toBe("368px");
    expect(await byTestId("logs-wrap").getAttribute("data-checked")).toBe("true");
    expect(await byTestId("logs-timestamps").getAttribute("data-checked")).toBe("false");
    await until(
      async () => (await byTestId("logs-view").getText()).includes("keeper line"),
      "the restored Logs tab never streamed",
    );
  });
});
