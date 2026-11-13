import { kubeconfig } from "../helpers/fixtures";
import {
  byTestId,
  clickWhenShown,
  expectHotbar,
  gone,
  hotbarItem,
  pointerClick,
  rowMenu,
  shown,
} from "../helpers/ui";

const KIND = "kind-skopos-e2e";
const DEAD = "dead";
const PANE = '[data-testid="workspace-pane"]';
const TAB = '[data-testid="workspace-tab"]';

async function count(selector: string): Promise<number> {
  return (await browser.$$(selector).getElements()).length;
}

async function expectCount(selector: string, n: number): Promise<void> {
  await browser.waitUntil(async () => (await count(selector)) === n, {
    timeout: 30000,
    timeoutMsg: `${selector} never counted ${n}`,
  });
}

/** Waits for at least one match; `$` refuses a selector that matches several. */
async function expectSome(selector: string, timeout: number): Promise<void> {
  await browser.waitUntil(async () => (await count(selector)) > 0, {
    timeout,
    timeoutMsg: `${selector} never matched`,
  });
}

async function summary(): Promise<string> {
  return (await shown("workspace-summary")).getText();
}

/** The driver's click cannot hold Shift, so send the click with it. */
async function shiftClick(element: WebdriverIO.Element): Promise<void> {
  await browser.execute((el) => {
    const target = el as unknown as HTMLElement;
    target.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        shiftKey: true,
      }),
    );
  }, element);
}

/** The driver's right button sends no contextmenu event, so send that part. */
async function openTabMenu(tab: WebdriverIO.Element): Promise<void> {
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
  }, tab);
}

async function tabMenu(tab: WebdriverIO.Element, item: string): Promise<void> {
  await openTabMenu(tab);
  await clickWhenShown(`workspace-menu-${item}`);
  await gone(`workspace-menu-${item}`);
}

/** Each pane's tabs as "cluster/view", with "^" after a pinned one. */
async function tabsByPane(): Promise<string[]> {
  return browser.execute(() =>
    [...document.querySelectorAll('[data-testid="workspace-pane"]')].map(
      (pane) =>
        [...pane.querySelectorAll('[data-testid="workspace-tab"]')]
          .map(
            (tab) =>
              `${tab.getAttribute("data-cluster")}/${tab.getAttribute("data-view")}${
                tab.getAttribute("data-pinned") === "true" ? "^" : ""
              }`,
          )
          .join(","),
    ),
  );
}

/** Puts the focus on the selected tab of a pane, so the Workspace's keys reach it. */
async function focusTabOfPane(index: number): Promise<void> {
  await browser.execute((i) => {
    const pane = document.querySelectorAll('[data-testid="workspace-pane"]')[i];
    pane
      ?.querySelector<HTMLElement>(
        '[data-testid="workspace-tab"][aria-selected="true"]',
      )
      ?.focus();
  }, index);
}

describe("the Workspace", () => {
  it("opens empty from the hotbar's Workspace item", async () => {
    await clickWhenShown("nav-catalog");
    await shown(`catalog-row-${KIND}`, 30000);
    await rowMenu(KIND, "pin");
    await expectHotbar([KIND]);

    await clickWhenShown("nav-workspace");

    await shown("workspace-page");
    const empty = await (await shown("workspace-empty")).getText();
    expect(empty).toContain("Pick a cluster in the hotbar to open it here");
    expect(empty).toContain("Shift-click opens it in a new pane to the side.");
    expect(await summary()).toBe("1 pane · 0 clusters · 0 tabs · 0 pinned");
  });

  it("opens the kind cluster on Pods with a click, and lists its Pods", async () => {
    await (await hotbarItem(KIND)).click();

    const tab = await browser.$(TAB);
    await tab.waitForDisplayed({ timeout: 15000 });
    expect(await tab.getAttribute("data-view")).toBe("pods");
    await shown("workspace-pods", 60000);
    await expectSome('[data-testid="workspace-pod"]', 60000);
  });

  it("opens a second pane with Shift-click and a third with Ctrl+\\", async () => {
    await shiftClick(await hotbarItem(KIND));
    await expectCount(PANE, 2);

    await focusTabOfPane(1);
    await browser.keys(["Control", "\\"]);
    await expectCount(PANE, 3);

    for (const split of await browser
      .$$('[data-testid="workspace-split"]')
      .getElements()) {
      expect(await split.isEnabled()).toBe(false);
    }
    expect(await summary()).toBe("3 panes · 1 cluster · 3 tabs · 0 pinned");
  });

  it("keeps a pinned tab on Close other tabs, and disables its close button", async () => {
    // Gather the three tabs in the first pane.
    await tabMenu((await browser.$$(TAB).getElements())[1], "left");
    await expectCount(PANE, 2);
    await tabMenu((await browser.$$(TAB).getElements())[2], "left");
    await expectCount(PANE, 1);
    await expectCount(TAB, 3);

    await tabMenu((await browser.$$(TAB).getElements())[0], "pin");
    await tabMenu((await browser.$$(TAB).getElements())[1], "others");

    await expectCount(TAB, 2);
    // The close button sits in the pinned tab's row. The selector goes through the
    // row, because parentElement() returns nothing under WebKitWebDriver.
    const close = await browser.$(
      '[role="presentation"][data-pinned="true"] [data-testid="workspace-tab-close"]',
    );
    await close.waitForExist({ timeout: 15000 });
    expect(await close.isEnabled()).toBe(false);
    expect(await summary()).toBe("1 pane · 1 cluster · 2 tabs · 1 pinned");
  });

  it("shows an unreachable cluster as Failed with Reconnect, while the kind pane keeps its data", async () => {
    await clickWhenShown("nav-catalog");
    await clickWhenShown("catalog-add");
    const yaml = await shown("catalog-add-yaml");
    await yaml.setValue(kubeconfig([DEAD], "https://127.0.0.1:1"));
    await clickWhenShown("catalog-add-submit");
    await gone("catalog-add-yaml");
    await rowMenu(DEAD, "pin");
    await expectHotbar([KIND, DEAD]);

    await clickWhenShown("nav-workspace");
    await shown("workspace-summary");
    // Split right focuses the new pane. A mouse press focuses the button before the
    // click, as a person's does; WebKitWebDriver's element click focuses it after the
    // click, which would hand the focus back to the first pane.
    await pointerClick(await shown("workspace-split"));
    await expectCount(PANE, 2);
    await (await hotbarItem(DEAD)).click();

    await shown("workspace-failed", 60000);
    await shown("workspace-reconnect");
    expect(await (await shown("workspace-failed")).getText()).toContain(
      "Cannot reach the cluster",
    );
    await expectSome(
      `${PANE}[data-pane="0"] [data-testid="workspace-pod"]`,
      30000,
    );
  });

  it("restores the panes, tabs and pins after a reload, and Reset layout empties it", async () => {
    const before = await tabsByPane();
    const counts = await summary();
    expect(counts).toBe("2 panes · 2 clusters · 4 tabs · 1 pinned");
    // The layout is saved 300 ms after the last change.
    await browser.pause(1000);

    await browser.refresh();

    await shown("workspace-summary", 30000);
    await browser.waitUntil(
      async () => JSON.stringify(await tabsByPane()) === JSON.stringify(before),
      { timeout: 30000, timeoutMsg: "the tabs were not restored" },
    );
    expect(await summary()).toBe(counts);

    await clickWhenShown("workspace-reset");

    await shown("workspace-empty");
    await expectCount(PANE, 1);
    expect(await summary()).toBe("1 pane · 0 clusters · 0 tabs · 0 pinned");
  });

  it("lists the Resource map and Workspace groups in the Keyboard shortcuts dialog", async () => {
    await browser.keys(["Control", "/"]);
    const dialog = await shown("shortcuts-dialog");

    const titles: string[] = [];
    for (const title of await dialog.$$("h3").getElements()) {
      titles.push(await title.getText());
    }
    expect(titles.slice(-2)).toEqual(["Resource map", "Workspace"]);
    await byTestId("shortcut-workspaceSplit").waitForDisplayed({
      timeout: 15000,
    });

    await browser.keys("Escape");
    await gone("shortcuts-dialog");
  });
});
