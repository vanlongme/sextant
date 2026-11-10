import { findHelm, serveFixtureCharts } from "../helpers/helmCharts";
import {
  expectFormStatus,
  expectRelease,
  expectToast,
  pickOption,
  releaseMenuItems,
  replaceText,
} from "../helpers/helm";
import { deleteTestNamespace } from "../helpers/kube";
import {
  byTestId,
  clickWhenShown,
  dialogButton,
  editorContaining,
  gone,
  openCluster,
  pointerClick,
  setEditorText,
  shown,
} from "../helpers/ui";

const KIND = "kind-skopos-e2e";
const NS = "skopos-test-helm";
const REPO = "skopos-e2e";
const CHART = "skopos-fixture";
const RELEASE = "fixture";
let charts: { url: string; close(): Promise<void> } | null = null;

async function waitText(id: string, text: string, timeout = 60000): Promise<void> {
  await browser.waitUntil(async () => (await byTestId(id).getText()).includes(text), {
    timeout,
    timeoutMsg: `${id} never showed ${text}`,
  });
}

async function pickFromMenu(item: string): Promise<void> {
  await pointerClick(await shown(`helm-release-menu-${NS}-${RELEASE}`));
  await clickWhenShown(`menu-item-${item}`);
}

describe("helm", () => {
  before(async function () {
    this.timeout(300000);
    await deleteTestNamespace(NS);
    charts = await serveFixtureCharts(findHelm().path);
    await openCluster(KIND);
  });

  after(async () => {
    await deleteTestNamespace(NS);
    await charts?.close();
  });

  it("shows helm with a version under Preferences › Tools", async () => {
    await clickWhenShown("nav-preferences");
    const row = await shown("pref-tool-helm", 30000);
    await browser.waitUntil(async () => /^helm v\d+\.\d+\.\d+ · /.test(await row.getText()), {
      timeout: 30000,
      timeoutMsg: "the helm row never showed a version",
    });
  });

  it("adds the served repository", async () => {
    await clickWhenShown("pref-repos-add");
    await replaceText("helm-repo-add-name", REPO);
    await replaceText("helm-repo-add-url", charts?.url ?? "");
    await clickWhenShown("helm-repo-add-submit");
    await expectToast(`"${REPO}" has been added to your repositories`);
    await shown(`pref-repo-${REPO}`);
  });

  it("lists the chart, renders its README and lists both versions", async () => {
    await openCluster(KIND);
    await clickWhenShown("nav-helm/charts");
    await clickWhenShown(`helm-chart-${REPO}-${CHART}`);
    const readme = await shown("helm-chart-readme");
    await readme.$(`h3=${CHART}`).waitForDisplayed({ timeout: 30000 });
    await pointerClick(await shown("helm-chart-tab-versions"));
    await shown("helm-chart-version-0.2.0", 30000);
    await shown("helm-chart-version-0.1.0");
  });

  it("dry-runs and installs 0.1.0 into a new namespace, then opens the release", async () => {
    await clickWhenShown("helm-chart-version-install-0.1.0");
    await shown("helm-form");
    await waitText("helm-form-version", "0.1.0 · app 1.0.0");
    await replaceText("helm-form-name", RELEASE);
    await replaceText("helm-form-namespace", NS);
    await clickWhenShown("helm-form-create-namespace");
    await editorContaining("message:");

    const dryRun = byTestId("helm-form-dry-run");
    await dryRun.waitForEnabled({ timeout: 30000 });
    await dryRun.click();
    await expectFormStatus("Dry run finished; nothing was changed.", 120000);
    expect(await (await shown("helm-form-preview-manifest")).getText()).toContain(
      `${RELEASE}-config`,
    );

    await clickWhenShown("helm-form-submit");
    await expectFormStatus("Installed.");
    await clickWhenShown("helm-form-open-release");
    await shown("helm-release-drawer");
    await waitText("helm-release-drawer-status", "deployed");
    await byTestId("helm-release-resources")
      .$(`a=${RELEASE}-config`)
      .waitForDisplayed({ timeout: 30000 });
    await pointerClick(await shown("helm-release-tab-manifest"));
    expect(await (await shown("helm-release-manifest")).getText()).toContain(
      `${RELEASE}-config`,
    );
  });

  it("upgrades to 0.2.0 with new values after the confirm", async () => {
    await clickWhenShown("helm-release-upgrade");
    await shown("helm-form");
    await editorContaining("message:");
    await pickOption("helm-form-version", "0.2.0 · app 1.1.0");
    await setEditorText("message: bye\n");
    const submit = byTestId("helm-form-submit");
    await submit.waitForEnabled({ timeout: 30000 });
    await submit.click();
    await shown("helm-upgrade-dialog");
    await dialogButton("Upgrade").click();
    await expectFormStatus("Upgraded.");
    await clickWhenShown("helm-form-open-release");
    await shown("helm-releases-screen");
    await expectRelease(NS, RELEASE, "2", "deployed");
  });

  it("rolls back to revision 1, which writes revision 3", async () => {
    await clickWhenShown("helm-release-drawer-close");
    await pickFromMenu("rollback");
    await shown("helm-rollback-dialog");
    await waitText("helm-rollback-revision", "Revision 1 ·");
    await dialogButton("Roll back").click();
    await expectToast(`Rolling back ${RELEASE} to revision 1`);
    await expectToast(`Rolled back ${RELEASE} to revision 1`, 180000);
    await expectRelease(NS, RELEASE, "3", "deployed");
  });

  it("uninstalls with the history kept, which leaves only Uninstall", async () => {
    await pickFromMenu("uninstall");
    await shown("helm-uninstall-dialog");
    await clickWhenShown("helm-uninstall-keep-history");
    await dialogButton("Uninstall").click();
    await expectToast(`Uninstalled ${RELEASE}`, 180000);
    await expectRelease(NS, RELEASE, "3", "uninstalled");
    expect(await releaseMenuItems(NS, RELEASE)).toEqual(["Uninstall"]);
    await browser.keys("Escape");
    await gone("menu-item-uninstall");
  });

  it("uninstalls again without the switch, and the row goes", async () => {
    await pickFromMenu("uninstall");
    await shown("helm-uninstall-dialog");
    expect(await byTestId("helm-uninstall-keep-history").isExisting()).toBe(false);
    await dialogButton("Uninstall").click();
    await gone(`helm-release-${NS}-${RELEASE}`, 180000);
  });

  it("removes the repository", async () => {
    await clickWhenShown("nav-preferences");
    await clickWhenShown(`pref-repo-remove-${REPO}`);
    await shown("helm-repo-remove-dialog");
    await dialogButton("Remove").click();
    await gone(`pref-repo-${REPO}`, 60000);
  });
});
