import fs from "node:fs";
import path from "node:path";
import { kubeconfig } from "../helpers/fixtures";
import {
  byTestId,
  catalogRow,
  clickWhenShown,
  expectHotbar,
  gone,
  hotbarItem,
  rowMenu,
  shown,
} from "../helpers/ui";

const home = process.env.SEXTANT_E2E_HOME as string;
const KIND = "kind-sextant-e2e";

/** Opens a cluster from the catalog by its name link. */
async function openFromCatalog(context: string): Promise<void> {
  await clickWhenShown("nav-catalog");
  await (await catalogRow(context)).$(`a=${context}`).then((link) => link.click());
}

async function statusText(): Promise<string> {
  return (await shown("connection-status")).getText();
}

async function expectStatus(text: string, timeout = 15000): Promise<void> {
  await browser.waitUntil(async () => (await statusText()) === text, {
    timeout,
    timeoutMsg: `connection status never became ${text}`,
  });
}

async function hotbarDot(name: string): Promise<string | null> {
  const dot = await (await hotbarItem(name)).$('[role="img"]');
  return dot.getAttribute("aria-label");
}

describe("cluster connection", () => {
  it("connects to the real kind cluster", async () => {
    await shown(`catalog-row-${KIND}`, 30000);
    await openFromCatalog(KIND);
    await expectStatus("Connected", 60000);
    await browser.waitUntil(
      async () => (await byTestId("cluster-info-distribution").getText()) === "kind",
      { timeout: 15000, timeoutMsg: "distribution never showed kind" },
    );
    expect(await byTestId("cluster-info-version").getText()).not.toBe("");
  });

  it("shows a failure for an unreachable cluster with reason and log", async () => {
    await openFromCatalog("dead");
    const heading = await browser.$("h3=Cannot reach the cluster");
    await heading.waitForDisplayed({ timeout: 30000 });
    await expectStatus("Failed");
    await browser.waitUntil(
      async () => (await byTestId("connection-log").getText()).trim() !== "",
      { timeout: 15000, timeoutMsg: "the connection log stayed empty" },
    );
    await shown("cluster-reconnect");
  });

  it("keeps several clusters connected and switches without reconnecting", async () => {
    await openFromCatalog("fake");
    await expectStatus("Connected", 30000);

    await clickWhenShown("nav-catalog");
    await rowMenu(KIND, "pin");
    await rowMenu("fake", "pin");
    await expectHotbar([KIND, "fake"]);

    for (const name of [KIND, "fake", KIND, "fake"]) {
      await (await hotbarItem(name)).click();
      // Read at once: a switch must show the live state, not pass through Connecting.
      await shown("connection-status");
      expect(await statusText()).toBe("Connected");
    }
    expect(await hotbarDot(KIND)).toBe("Connected");
    expect(await hotbarDot("fake")).toBe("Connected");
  });

  it("disconnect and reconnect work", async () => {
    await (await hotbarItem("fake")).click();
    await clickWhenShown("cluster-disconnect");
    await expectStatus("Disconnected");
    await clickWhenShown("cluster-reconnect");
    await expectStatus("Connected", 30000);
  });

  it("clicking a pinned disconnected cluster connects it", async () => {
    await (await hotbarItem("fake")).click();
    await clickWhenShown("cluster-disconnect");
    await expectStatus("Disconnected");

    await clickWhenShown("nav-catalog");
    await shown("catalog-row-fake");
    await (await hotbarItem("fake")).click();
    await expectStatus("Connected", 30000);
  });

  it("removing a context on disk disconnects and removes it", async () => {
    await clickWhenShown("nav-catalog");
    await shown("catalog-row-fake");

    fs.writeFileSync(path.join(home, ".kube", "fake"), kubeconfig(["other"]));

    await gone("catalog-row-fake", 5000);
    await shown("catalog-row-other");
  });
});
