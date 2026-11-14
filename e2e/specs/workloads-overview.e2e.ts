import fs from "node:fs";
import path from "node:path";
import { createTestNamespace, deleteTestNamespace, kubectl } from "../helpers/kube";
import { byTestId, clickWhenShown, openCluster, shown } from "../helpers/ui";

const KIND = "kind-skopos-e2e";
const NS = "skopos-test-workloads";
// The worktree's git-ignored tmp/, two levels up from e2e/specs.
const OUT = path.resolve(__dirname, "../../tmp/screens");
const until = (check: () => Promise<boolean>, timeoutMsg: string) =>
  browser.waitUntil(check, { timeout: 60000, interval: 500, timeoutMsg });

/**
 * The numbers of a kind's row: Total, Healthy, Pending, Failing. Cell by cell, since
 * the driver joins a row's text with no space between cells.
 */
async function counts(plural: string): Promise<number[]> {
  const cells = await $$(`[data-testid="workload-kind-${plural}"] td`);
  const texts: string[] = [];
  for (const cell of cells.slice(1)) texts.push(await cell.getText());
  return texts.map((t) => Number(t.trim()));
}

describe("workloads overview", () => {
  before(async () => {
    await deleteTestNamespace(NS);
    await createTestNamespace(NS);
    // Its image never pulls, so it is a failing pod with Warning events.
    await kubectl(["-n", NS, "run", "broken", "--image=registry.invalid/none:1", "--restart=Never"]);
    await openCluster(KIND);
  });

  after(async () => {
    await deleteTestNamespace(NS);
  });

  it("counts each workload kind by the status its list shows", async () => {
    await clickWhenShown("nav-overview-workloads");
    await shown("workloads-overview-title");
    await until(async () => {
      const [total, healthy, , failing] = await counts("pods");
      return total > 0 && healthy > 0 && failing > 0;
    }, "the Pods row never counted a healthy and a failing pod");
    await until(async () => (await counts("deployments"))[0] > 0, "no Deployment was counted");
    const [total, healthy, pending, failing] = await counts("pods");
    expect(total).toBeGreaterThanOrEqual(healthy + pending + failing);
  });

  it("lists recent events and links each kind to its list", async () => {
    await until(
      async () => (await $$('[data-testid="workload-event"]').length) > 0,
      "no recent event was listed",
    );
    fs.mkdirSync(OUT, { recursive: true });
    for (const theme of ["light", "dark"] as const) {
      await browser.execute((t) => {
        document.documentElement.dataset.theme = t;
      }, theme);
      await browser.pause(300);
      await browser.saveScreenshot(path.join(OUT, `workloads-overview-${theme}.png`));
    }
    await (await byTestId("workload-kind-pods")).$("a=Pods").then((link) => link.click());
    await until(
      async () => (await $$('[data-testid^="resource-row-"]').length) > 0,
      "the Pods link did not open the Pods list",
    );
  });
});
