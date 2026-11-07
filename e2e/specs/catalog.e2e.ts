import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { kubeconfig } from "../helpers/fixtures";
import {
  byTestId,
  catalogRow,
  clickWhenShown,
  expectHotbar,
  gone,
  hotbarItem,
  pointerClick,
  rowMenu,
  shown,
} from "../helpers/ui";

const home = process.env.SKOPOS_E2E_HOME as string;

describe("catalog", () => {
  it("lists contexts from ~/.kube", async () => {
    await shown("catalog-row-alpha", 30000);
    await shown("catalog-row-beta");
    await shown("status-bar");
  });

  it("filters by search", async () => {
    const search = await shown("catalog-search");
    await search.setValue("bet");
    await gone("catalog-row-alpha");
    await shown("catalog-row-beta");

    await search.clearValue();
    await shown("catalog-row-alpha");
  });

  it("adds a pasted kubeconfig", async () => {
    await clickWhenShown("catalog-add");
    const yaml = await shown("catalog-add-yaml");
    await yaml.setValue(kubeconfig(["gamma"]));
    await clickWhenShown("catalog-add-submit");

    await gone("catalog-add-yaml");
    await shown("catalog-row-gamma");
  });

  it("keeps the add dialog open and explains invalid input", async () => {
    await clickWhenShown("catalog-add");
    const yaml = await shown("catalog-add-yaml");
    await yaml.setValue("kind: Config\n");
    await clickWhenShown("catalog-add-submit");

    const problem = browser.$('[role="dialog"] [role="alert"]');
    await problem.waitForDisplayed({ timeout: 15000 });
    expect(await problem.getText()).not.toBe("");
    await (await browser.$('[role="dialog"]').$("button=Cancel")).click();
    await gone("catalog-add-yaml");
  });

  it("removes a pasted cluster only after confirming", async () => {
    await rowMenu("gamma", "remove");
    const dialog = browser.$('[role="dialog"]');
    await dialog.waitForDisplayed({ timeout: 15000 });
    expect(await dialog.getText()).toContain("gamma");

    await (await dialog.$("button=Cancel")).click();
    await dialog.waitForExist({ timeout: 15000, reverse: true });
    await shown("catalog-row-gamma");

    await rowMenu("gamma", "remove");
    await dialog.waitForDisplayed({ timeout: 15000 });
    await (await dialog.$("button=Remove")).click();
    await gone("catalog-row-gamma");
  });

  it("offers no remove for a synced cluster", async () => {
    await pointerClick(await shown("catalog-menu-alpha"));
    await shown("menu-item-pin");
    expect(await byTestId("menu-item-remove").isExisting()).toBe(false);
    await browser.keys("Escape");
    await gone("menu-item-pin");
  });

  it("picks up a new file on disk", async () => {
    fs.writeFileSync(path.join(home, ".kube", "extra"), kubeconfig(["delta"]));

    await shown("catalog-row-delta", 5000);
  });

  it("pins to hotbar and persists order across a reload", async () => {
    await rowMenu("alpha", "pin");
    await rowMenu("beta", "pin");
    await expectHotbar(["alpha", "beta"]);

    await browser.refresh();

    await shown("catalog-row-alpha", 30000);
    await expectHotbar(["alpha", "beta"]);
  });

  it("drags a hotbar item to a new place", async () => {
    const source = await hotbarItem("alpha");
    const target = await hotbarItem("beta");
    const from = await source.getLocation();
    const size = await source.getSize();
    const to = await target.getLocation();
    const x = Math.round(from.x + size.width / 2);
    const startY = Math.round(from.y + size.height / 2);
    const endY = Math.round(to.y + size.height / 2);

    await browser
      .action("pointer", { parameters: { pointerType: "mouse" } })
      .move({ x, y: startY })
      .down({ button: 0 })
      .pause(100)
      .move({ x, y: startY + 10, duration: 100 })
      .pause(100)
      .move({ x, y: endY + 8, duration: 200 })
      .pause(200)
      .up({ button: 0 })
      .perform();

    await expectHotbar(["beta", "alpha"]);
  });

  it("reorders a hotbar item with the keyboard", async () => {
    const item = await hotbarItem("alpha");
    await browser.execute((el) => (el as unknown as HTMLElement).focus(), item);

    await browser.keys("Space");
    await browser.pause(100);
    await browser.keys("ArrowUp");
    await browser.pause(300);
    await browser.keys("Space");

    await expectHotbar(["alpha", "beta"]);
    await shown("catalog-row-alpha"); // Space moved the item without opening it.
  });

  it("opens a cluster from the hotbar", async () => {
    await (await hotbarItem("alpha")).click();
    const heading = browser.$("h2=alpha");
    await heading.waitForDisplayed({ timeout: 15000 });

    await clickWhenShown("nav-catalog");
    await shown("catalog-row-alpha");
  });

  it("unpins from the hotbar context menu", async () => {
    // The driver's right button sends no contextmenu event, so send that part.
    const item = await hotbarItem("alpha");
    await browser.execute((el) => {
      const target = el as unknown as HTMLElement;
      const { x, y } = target.getBoundingClientRect();
      target.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          clientX: x + 4,
          clientY: y + 4,
        }),
      );
    }, item);
    await clickWhenShown("menu-item-unpin");

    await expectHotbar(["beta"]);
  });

  it("adds and removes a source in Preferences", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "skopos-e2e-src-"));
    const file = path.join(outside, "epsilon.yaml");
    fs.writeFileSync(file, kubeconfig(["epsilon"]));

    await clickWhenShown("nav-preferences");
    const input = await shown("pref-source-input");
    await input.setValue(file);
    await clickWhenShown("pref-source-add");
    await browser.waitUntil(
      async () => {
        const rows = await browser
          .$$('[data-testid="pref-source-row"]')
          .getElements();
        for (const row of rows) {
          if ((await row.getText()).includes(file)) return true;
        }
        return false;
      },
      { timeout: 15000, timeoutMsg: "the new source is not listed" },
    );

    await clickWhenShown("nav-catalog");
    await shown("catalog-row-epsilon", 5000);

    await clickWhenShown("nav-preferences");
    await (await browser.$(`[aria-label="Remove ${file}"]`)).click();
    await clickWhenShown("nav-catalog");
    await gone("catalog-row-epsilon", 5000);
    await shown("catalog-row-alpha");

    fs.rmSync(outside, { recursive: true, force: true });
  });
});
