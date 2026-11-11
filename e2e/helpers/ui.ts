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

/** Waits for the open cluster to say Connected. */
export async function expectConnected(timeout = 60000): Promise<void> {
  await browser.waitUntil(
    async () =>
      (await (await shown("connection-status")).getText()) === "Connected",
    { timeout, timeoutMsg: "connection status never became Connected" },
  );
}

/** Opens a cluster by its name link in the catalog, and waits for its sidebar. */
export async function openCluster(context: string): Promise<void> {
  await clickWhenShown("nav-catalog");
  await shown(`catalog-row-${context}`, 30000);
  await (await catalogRow(context))
    .$(`a=${context}`)
    .then((link) => link.click());
  await expectConnected();
  await shown("cluster-sidebar");
}

/** Clicks a sidebar entry and waits for the screen of that kind. */
export async function openResource(
  navItem: string,
  kind: string,
): Promise<void> {
  await clickWhenShown(navItem);
  await expectResourceTitle(kind);
}

export async function expectResourceTitle(kind: string): Promise<void> {
  await browser.waitUntil(
    async () => {
      const title = byTestId("resource-title");
      return (await title.isExisting()) && (await title.getText()) === kind;
    },
    {
      timeout: TIMEOUT,
      timeoutMsg: `the resource screen never showed ${kind}`,
    },
  );
}

export function rowId(namespace: string, name: string): string {
  return `resource-row-${namespace}-${name}`;
}

/** The test IDs of the rows on screen, top to bottom. */
export async function rowIds(): Promise<string[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll('[data-testid^="resource-row-"]')).map(
      (row) => row.getAttribute("data-testid") ?? "",
    ),
  );
}

/** Waits until the rows on screen satisfy `check`. */
export async function expectRows(
  what: string,
  check: (ids: string[]) => boolean,
): Promise<void> {
  let last: string[] = [];
  await browser
    .waitUntil(
      async () => {
        last = await rowIds();
        return check(last);
      },
      { timeout: TIMEOUT },
    )
    .catch(() => {
      throw new Error(
        `the table never showed ${what}; it has ${last.join(", ")}`,
      );
    });
}

export async function expectRowsExactly(expected: string[]): Promise<void> {
  await expectRows(
    expected.join(", "),
    (ids) => JSON.stringify(ids) === JSON.stringify(expected),
  );
}

export async function searchResources(text: string): Promise<void> {
  await (await shown("resource-search")).setValue(text);
}

/** Picks an item from the menu at the end of a resource row. */
export async function resourceRowMenu(
  name: string,
  item: string,
): Promise<void> {
  await pointerClick(await shown(`row-menu-${name}`));
  await clickWhenShown(`menu-item-${item}`);
  await gone(`menu-item-${item}`);
}

/** Toggles entries of a menu of checkboxes, then closes it. */
export async function toggleInCheckMenu(
  trigger: string,
  options: string[],
): Promise<void> {
  await pointerClick(await shown(trigger));
  for (const option of options) await clickWhenShown(option);
  await browser.keys("Escape");
  for (const option of options) await gone(option);
}

/** The header texts of the resource table, without the select-all cell. */
export async function tableHeaders(): Promise<string[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll('[data-testid="resource-table"] th'))
      .map((th) => (th.textContent ?? "").replace(/[▲▼]/g, "").trim())
      .filter((text) => text !== ""),
  );
}

export function dialogButton(label: string) {
  return browser.$(
    `//*[@role="dialog"]//button[normalize-space()="${label}"]`,
  );
}

interface MonacoEditor {
  getDomNode(): HTMLElement | null;
  getValue(): string;
  getModel(): { setValue(text: string): void } | null;
}

/** What the test build of the app puts on `window`. */
type MonacoWindow = { monaco?: { editor: { getEditors(): MonacoEditor[] } } };

/** The text of the editor on screen, or null when there is none yet. */
export async function editorText(): Promise<string | null> {
  return browser.execute(() => {
    const { monaco } = window as unknown as MonacoWindow;
    const visible = monaco?.editor
      .getEditors()
      .find((e) => e.getDomNode()?.offsetParent);
    return visible ? visible.getValue() : null;
  });
}

/** Waits until the editor on screen holds text that contains `part`, and gives all of it. */
export async function editorContaining(part: string): Promise<string> {
  let text: string | null = null;
  await browser.waitUntil(
    async () => {
      text = await editorText();
      return text?.includes(part) ?? false;
    },
    { timeout: TIMEOUT, timeoutMsg: `the editor never contained ${part}` },
  );
  return text ?? "";
}

/** Replaces the text of the editor on screen through Monaco's model. */
export async function setEditorText(text: string): Promise<void> {
  await browser.execute((value: string) => {
    const { monaco } = window as unknown as MonacoWindow;
    const visible = monaco?.editor
      .getEditors()
      .find((e) => e.getDomNode()?.offsetParent);
    visible?.getModel()?.setValue(value);
  }, text);
}

async function dockTabCount(): Promise<number> {
  return browser.$$('[data-testid^="dock-close-"]').length;
}

/** Closes every dock tab, discarding unsaved changes. */
export async function closeDockTabs(): Promise<void> {
  for (let left = await dockTabCount(); left > 0; left = await dockTabCount()) {
    await browser.$$('[data-testid^="dock-close-"]')[0].click();
    const discard = dialogButton("Discard");
    await browser.waitUntil(
      async () => (await discard.isExisting()) || (await dockTabCount()) < left,
      { timeout: TIMEOUT, timeoutMsg: "closing a dock tab did nothing" },
    );
    if (await discard.isExisting()) await discard.click();
    await browser.waitUntil(async () => (await dockTabCount()) < left, {
      timeout: TIMEOUT,
      timeoutMsg: "a dock tab stayed open after discarding",
    });
  }
}

/** The titles of the dock's tabs, left to right. */
export async function dockTabTitles(): Promise<string[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll('[data-testid="dock"] [role="tab"]')).map(
      (tab) => tab.textContent ?? "",
    ),
  );
}

/** The panel of the dock tab on screen. Hidden panels keep their content. */
export const DOCK_PANEL = '[data-testid="dock"] [role="tabpanel"]:not([hidden])';

/** An element of the dock tab on screen. */
export function inDockPanel(id: string) {
  return browser.$(`${DOCK_PANEL} [data-testid="${id}"]`);
}

/** The rows xterm draws in the terminal on screen, top to bottom, without trailing spaces. */
export async function terminalRows(): Promise<string[]> {
  return browser.execute(
    (panel) =>
      Array.from(document.querySelectorAll(`${panel} .xterm-rows > div`)).map((row) =>
        (row.textContent ?? "").replace(/\u00a0/g, " ").trimEnd(),
      ),
    DOCK_PANEL,
  );
}

export async function terminalStatus(): Promise<string> {
  return inDockPanel("terminal-status").getText();
}

export async function expectTerminalStatus(label: string, timeout = 60000): Promise<void> {
  await browser.waitUntil(async () => (await terminalStatus()) === label, {
    timeout,
    interval: 500,
    timeoutMsg: `the terminal status never read "${label}"`,
  });
}

/** Waits for a row that reads exactly `line`, apart from surrounding spaces. */
export async function expectTerminalLine(line: string, timeout = 60000): Promise<void> {
  await browser.waitUntil(
    async () => (await terminalRows()).some((row) => row.trim() === line),
    { timeout, interval: 500, timeoutMsg: `the terminal never printed the line "${line}"` },
  );
}

/**
 * Types `text` into the terminal on screen, then presses Enter. WebKitWebDriver gives a key
 * action's keydown a keyCode equal to the character code, which xterm reads as a function key
 * for `p`, `s`, `$`, `-` and others. So each character goes in as the text-insertion input event
 * xterm also accepts, and only Enter is a key press.
 */
export async function typeInTerminal(text: string): Promise<void> {
  await browser.execute(
    (panel, chars) => {
      const area = document.querySelector<HTMLTextAreaElement>(`${panel} .xterm-helper-textarea`);
      if (!area) throw new Error("no terminal on screen");
      area.focus();
      for (const ch of chars) {
        area.dispatchEvent(new InputEvent("input", { data: ch, inputType: "insertText" }));
      }
    },
    DOCK_PANEL,
    Array.from(text),
  );
  await browser.keys("Enter");
}

/** Picks Shell on a node's row menu and waits for its confirmation. */
export async function requestNodeShell(node: string): Promise<void> {
  await openResource("nav-item-core-nodes", "Node");
  await searchResources(node);
  await resourceRowMenu(node, "nodeShell");
  await dialogButton("Open shell").waitForExist({ timeout: TIMEOUT });
}
