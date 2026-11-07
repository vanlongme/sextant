import { createTestNamespace, deleteTestNamespace, kubectl } from "../helpers/kube";
import {
  byTestId, clickWhenShown, openCluster, openResource, rowId, searchResources, shown,
} from "../helpers/ui";

const KIND = "kind-skopos-e2e";
const NS = "skopos-test-config";
const LAST_APPLIED = "{.metadata.annotations.kubectl\\.kubernetes\\.io/last-applied-configuration}";
const MANIFEST = `
apiVersion: v1
kind: ConfigMap
metadata:
  name: settings
  namespace: ${NS}
data:
  mode: fast
---
apiVersion: v1
kind: Secret
metadata:
  name: creds
  namespace: ${NS}
stringData:
  password: e2e-hidden-value
`;
const until = (check: () => Promise<boolean>, timeoutMsg: string) =>
  browser.waitUntil(check, { timeout: 60000, interval: 500, timeoutMsg });

async function openDrawer(nav: string, kind: string, name: string) {
  await openResource(nav, kind);
  await searchResources(name);
  await byTestId(rowId(NS, name)).click();
  await shown("detail-drawer");
}

describe("editing config in the drawer", () => {
  before(async () => {
    await deleteTestNamespace(NS);
    await createTestNamespace(NS);
    await kubectl(["apply", "-f", "-"], MANIFEST);
    await openCluster(KIND);
  });

  after(async () => {
    await deleteTestNamespace(NS);
  });

  it("edits a ConfigMap in the drawer", async () => {
    await openDrawer("nav-item-core-configmaps", "ConfigMap", "settings");
    await (await shown("configmap-input-mode")).setValue("slow");
    await clickWhenShown("data-save");
    await until(
      async () => (await kubectl(["-n", NS, "get", "configmap", "settings", "-o", "jsonpath={.data.mode}"])) === "slow",
      "the ConfigMap never changed",
    );
    const applied = await kubectl(["-n", NS, "get", "configmap", "settings", "-o", `jsonpath=${LAST_APPLIED}`]);
    expect(applied).toContain("settings");
    await clickWhenShown("detail-close");
  });

  it("keeps a Secret value out of the page until it is revealed", async () => {
    await openDrawer("nav-item-core-secrets", "Secret", "creds");
    expect(await browser.getPageSource()).not.toContain("e2e-hidden-value");
    await clickWhenShown("secret-reveal-password");
    await until(async () => (await browser.getPageSource()).includes("e2e-hidden-value"), "the value never showed");
    await clickWhenShown("secret-reveal-password");
    await until(async () => !(await browser.getPageSource()).includes("e2e-hidden-value"), "the value stayed after hiding");
    await clickWhenShown("detail-close");
  });

  it("edits a Secret value", async () => {
    await openDrawer("nav-item-core-secrets", "Secret", "creds");
    await clickWhenShown("secret-reveal-password");
    await clickWhenShown("secret-edit-password");
    await (await shown("secret-input-password")).setValue("changed-value");
    await clickWhenShown("data-save");
    const expected = Buffer.from("changed-value").toString("base64");
    await until(
      async () => (await kubectl(["-n", NS, "get", "secret", "creds", "-o", "jsonpath={.data.password}"])) === expected,
      "the Secret never changed",
    );
    await clickWhenShown("detail-close");
  });

  it("a stale save is refused and keeps the text", async () => {
    await openDrawer("nav-item-core-configmaps", "ConfigMap", "settings");
    const input = await shown("configmap-input-mode");
    await input.setValue("typed-text");
    await kubectl(["-n", NS, "patch", "configmap", "settings", "--type=merge", "-p", '{"data":{"mode":"server"}}']);
    await shown("data-changed-on-server");
    await clickWhenShown("data-save");
    await shown("data-conflict");
    expect(await (await shown("configmap-input-mode")).getValue()).toBe("typed-text");
    expect(await kubectl(["-n", NS, "get", "configmap", "settings", "-o", "jsonpath={.data.mode}"])).toBe("server");
  });
});
