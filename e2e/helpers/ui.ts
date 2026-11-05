const TIMEOUT = 15000;

export function byTestId(id: string) {
  return browser.$(`[data-testid="${id}"]`);
}

export function catalogRow(context: string) {
  return byTestId(`catalog-row-${context}`);
}

export async function shown(id: string, timeout = TIMEOUT) {
  const element = byTestId(id);
  await element.waitForDisplayed({ timeout });
  return element;
}

export async function gone(id: string, timeout = TIMEOUT): Promise<void> {
  await byTestId(id).waitForExist({ timeout, reverse: true });
}

export async function clickWhenShown(id: string): Promise<void> {
  await (await shown(id)).click();
}

/**
 * A press and release of the real pointer. The driver's element click does not
 * send pointer events, which Radix menus open on.
 */
export async function pointerClick(element: WebdriverIO.Element): Promise<void> {
  const at = await element.getLocation();
  const size = await element.getSize();
  await browser
    .action("pointer", { parameters: { pointerType: "mouse" } })
    .move({
      x: Math.round(at.x + size.width / 2),
      y: Math.round(at.y + size.height / 2),
    })
    .down({ button: 0 })
    .up({ button: 0 })
    .perform();
}

/** Picks an item from a catalog row's menu. */
export async function rowMenu(context: string, item: string): Promise<void> {
  await pointerClick(await shown(`catalog-menu-${context}`));
  await clickWhenShown(`menu-item-${item}`);
  await gone(`menu-item-${item}`);
}

/** The labels of the pinned clusters, top to bottom. */
export async function hotbarOrder(): Promise<string[]> {
  const items = await browser.$$('[data-testid^="hotbar-item-"]').getElements();
  const labels: string[] = [];
  for (const item of items) labels.push((await item.getAttribute("aria-label")) ?? "");
  return labels;
}

export async function expectHotbar(order: string[]): Promise<void> {
  await browser.waitUntil(
    async () => JSON.stringify(await hotbarOrder()) === JSON.stringify(order),
    {
      timeout: TIMEOUT,
      timeoutMsg: `hotbar never showed ${order.join(", ")}`,
    },
  );
}

/** The hotbar element whose cluster has this name. */
export function hotbarItem(name: string) {
  return browser.$(`[data-testid^="hotbar-item-"][aria-label="${name}"]`);
}
