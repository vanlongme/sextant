import { byTestId, pointerClick, shown } from "./ui";

/** Waits until a toast holds `text`. */
export async function expectToast(text: string, timeout = 60000): Promise<void> {
  await browser.waitUntil(
    async () => {
      for (const toast of await browser.$$('[data-testid="toast"]')) {
        if ((await toast.getText()).includes(text)) return true;
      }
      return false;
    },
    { timeout, timeoutMsg: `no toast said ${text}` },
  );
}

/** The cell texts of a release row. */
export async function releaseCells(namespace: string, name: string): Promise<string[]> {
  const cells = await byTestId(`helm-release-${namespace}-${name}`).$$("td");
  const texts: string[] = [];
  for (const cell of cells) texts.push((await cell.getText()).trim());
  return texts;
}

/** Waits until a release row's Revision and Status cells read `revision` and `status`. */
export async function expectRelease(
  namespace: string,
  name: string,
  revision: string,
  status: string,
  timeout = 60000,
): Promise<void> {
  let last: string[] = [];
  await browser
    .waitUntil(
      async () => {
        if (!(await byTestId(`helm-release-${namespace}-${name}`).isExisting())) {
          return false;
        }
        last = await releaseCells(namespace, name);
        return last[4] === revision && last[5] === status;
      },
      { timeout, interval: 1000 },
    )
    .catch(() => {
      throw new Error(
        `release ${namespace}/${name} never read revision ${revision} ${status}; last: ${last.join(" | ")}`,
      );
    });
}

/** Opens a release's row menu and gives its item labels. */
export async function releaseMenuItems(namespace: string, name: string): Promise<string[]> {
  await pointerClick(await shown(`helm-release-menu-${namespace}-${name}`));
  await shown("menu-item-uninstall");
  const items = await browser.$$('[role="menuitem"]');
  const labels: string[] = [];
  for (const item of items) labels.push((await item.getText()).trim());
  return labels;
}

/** Picks an option of a Radix select by its text. */
export async function pickOption(selectId: string, label: string): Promise<void> {
  await pointerClick(await shown(selectId));
  const option = browser.$(`//*[@role="option"][normalize-space()="${label}"]`);
  await option.waitForDisplayed({ timeout: 15000 });
  await option.click();
}

/** Replaces the text of a field the way a user does, so React sees every change. */
export async function replaceText(id: string, text: string): Promise<void> {
  await (await shown(id)).click();
  await browser.keys(["Control", "a"]);
  await browser.keys("Backspace");
  await byTestId(id).addValue(text);
}

/** Waits until the form's Output status reads `text`. */
export async function expectFormStatus(text: string, timeout = 180000): Promise<void> {
  let last = "";
  await browser
    .waitUntil(
      async () => {
        last = await byTestId("helm-form-status").getText();
        return last === text;
      },
      { timeout, interval: 500 },
    )
    .catch(() => {
      throw new Error(`the form status never read "${text}"; last: "${last}"`);
    });
}
