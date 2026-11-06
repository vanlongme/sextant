import {
  createTestNamespace,
  deleteTestNamespace,
  kubectl,
} from "../helpers/kube";
import {
  byTestId,
  clickWhenShown,
  closeDockTabs,
  dialogButton,
  editorContaining,
  editorText,
  gone,
  openCluster,
  openResource,
  resourceRowMenu,
  rowId,
  setEditorText,
  shown,
} from "../helpers/ui";

const KIND = "kind-sextant-e2e";
const NS = "sextant-test-e2e";

async function createConfigMap(name: string, value: string): Promise<void> {
  await kubectl([
    "-n",
    NS,
    "create",
    "configmap",
    name,
    `--from-literal=key=${value}`,
  ]);
}

async function storedValue(name: string): Promise<string> {
  return kubectl([
    "-n",
    NS,
    "get",
    "configmap",
    name,
    "-o",
    "jsonpath={.data.key}",
  ]);
}

async function resourceVersion(name: string): Promise<string> {
  return kubectl([
    "-n",
    NS,
    "get",
    "configmap",
    name,
    "-o",
    "jsonpath={.metadata.resourceVersion}",
  ]);
}

async function changeOnServer(name: string, value: string): Promise<void> {
  await kubectl([
    "-n",
    NS,
    "patch",
    "configmap",
    name,
    "--type=merge",
    "-p",
    JSON.stringify({ data: { key: value } }),
  ]);
}

async function expectStored(name: string, value: string): Promise<void> {
  await browser.waitUntil(async () => (await storedValue(name)) === value, {
    timeout: 15000,
    timeoutMsg: `${name} never held ${value} in the cluster`,
  });
}

/** Opens a config map from its row menu and waits for its YAML. */
async function openEditor(name: string, value: string): Promise<string> {
  await openResource("nav-item-core-configmaps", "ConfigMap");
  await shown(rowId(NS, name));
  await resourceRowMenu(name, "edit");
  return editorContaining(`key: ${value}`);
}

async function typeValue(
  text: string,
  from: string,
  to: string,
): Promise<void> {
  await setEditorText(text.replace(`key: ${from}`, `key: ${to}`));
  await editorContaining(`key: ${to}`);
}

async function clickSave(): Promise<void> {
  const save = await shown("yaml-save");
  await save.waitForEnabled({ timeout: 15000 });
  await save.click();
}

describe("YAML editor", () => {
  before(async () => {
    await createTestNamespace(NS);
    await openCluster(KIND);
  });

  afterEach(async () => {
    await closeDockTabs();
  });

  after(async () => {
    await deleteTestNamespace(NS);
  });

  it("edits a ConfigMap and the cluster reflects it", async () => {
    await createConfigMap("edited", "before");
    const text = await openEditor("edited", "before");

    await typeValue(text, "before", "after");
    await clickSave();

    await expectStored("edited", "after");
    // What was saved now counts as loaded, so there is nothing left to save.
    await byTestId("yaml-save").waitForEnabled({
      timeout: 15000,
      reverse: true,
    });
  });

  it("flags invalid YAML and does not send it", async () => {
    await createConfigMap("invalid", "kept");
    const version = await resourceVersion("invalid");
    await openEditor("invalid", "kept");

    await setEditorText("metadata: [unclosed\n");

    await shown("yaml-error");
    expect(await byTestId("yaml-save").isEnabled()).toBe(false);
    expect(await resourceVersion("invalid")).toBe(version);
    expect(await storedValue("invalid")).toBe("kept");
  });

  it("handles a conflict: reload, then overwrite", async () => {
    await createConfigMap("conflict", "first");
    let text = await openEditor("conflict", "first");

    await changeOnServer("conflict", "server-1");
    await typeValue(text, "first", "mine-1");
    await clickSave();
    await shown("conflict-dialog");
    expect(await storedValue("conflict")).toBe("server-1");

    await clickWhenShown("conflict-reload");
    await gone("conflict-dialog");
    text = await editorContaining("key: server-1");
    expect(await storedValue("conflict")).toBe("server-1");

    await changeOnServer("conflict", "server-2");
    await typeValue(text, "server-1", "mine-2");
    await clickSave();
    await shown("conflict-dialog");

    await clickWhenShown("conflict-overwrite");
    await gone("conflict-dialog");
    await expectStored("conflict", "mine-2");
  });

  it("shows an API validation error verbatim", async () => {
    await createConfigMap("rejected", "kept");
    const text = await openEditor("rejected", "kept");

    // Valid YAML that the API server refuses: an immutable field.
    await setEditorText(text.replace("name: rejected", "name: renamed"));
    await editorContaining("name: renamed");
    await clickSave();

    const notice = await shown("yaml-api-error");
    await browser.waitUntil(async () => (await notice.getText()).length > 0);
    expect(await notice.getText()).toMatch(/rejected|renamed|immutable|name/i);
    expect(await storedValue("rejected")).toBe("kept");
  });

  it("creates multiple documents and reports each", async () => {
    await clickWhenShown("create-resource");
    await shown("create-apply");
    await browser.waitUntil(async () => (await editorText()) !== null, {
      timeout: 15000,
      timeoutMsg: "the create tab's editor never loaded",
    });

    await setEditorText(
      [
        "apiVersion: v1",
        "kind: ConfigMap",
        "metadata:",
        "  name: created-ok",
        `  namespace: ${NS}`,
        "data:",
        "  key: created",
        "---",
        "apiVersion: e2e.invalid/v1",
        "kind: NoSuchKind",
        "metadata:",
        "  name: created-bad",
        `  namespace: ${NS}`,
        "",
      ].join("\n"),
    );
    await editorContaining("NoSuchKind");
    const apply = await shown("create-apply");
    await apply.waitForEnabled({ timeout: 15000 });
    await apply.click();

    await shown("apply-results");
    expect(await byTestId("apply-result-0").getAttribute("data-ok")).toBe(
      "true",
    );
    expect(await byTestId("apply-result-1").getAttribute("data-ok")).toBe(
      "false",
    );
    expect(await browser.$$('[data-testid^="apply-result-"]').length).toBe(2);
    expect(await storedValue("created-ok")).toBe("created");
  });

  it("closing a dirty tab asks first", async () => {
    await createConfigMap("dirty", "clean");
    const text = await openEditor("dirty", "clean");
    await typeValue(text, "clean", "unsaved");

    const close = browser.$('[data-testid^="dock-close-"]');
    await close.click();
    await dialogButton("Discard").waitForDisplayed({ timeout: 15000 });

    await dialogButton("Cancel").click();
    await dialogButton("Discard").waitForExist({
      timeout: 15000,
      reverse: true,
    });
    expect(await close.isExisting()).toBe(true);
    expect(await editorText()).toContain("key: unsaved");

    await close.click();
    await dialogButton("Discard").click();
    await close.waitForExist({ timeout: 15000, reverse: true });
    expect(await storedValue("dirty")).toBe("clean");
  });
});
