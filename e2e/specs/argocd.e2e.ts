import fs from "node:fs";
import path from "node:path";
import { createTestNamespace, deleteTestNamespace, kubectl } from "../helpers/kube";
import {
  byTestId, clickWhenShown, dialogButton, gone, openCluster, openResource, pointerClick,
  resourceRowMenu, rowId, searchResources, shown,
} from "../helpers/ui";

const KIND = "kind-skopos-e2e";
const NS = "skopos-test-argocd";
const OBJECTS = fs.readFileSync(path.resolve(__dirname, "..", "fixtures", "argocd.yaml"), "utf8");
const APPS = "nav-item-argoproj.io-applications";
const TEAMS_STATUS = {
  status: {
    resources: ["drop-a", "drop-b"].map((name) => ({
      group: "argoproj.io", version: "v1alpha1", kind: "Application", namespace: NS, name,
      status: "Synced", health: { status: "Healthy" },
    })),
  },
};
const until = (check: () => Promise<boolean>, timeoutMsg: string) =>
  browser.waitUntil(check, { timeout: 60000, interval: 500, timeoutMsg });

async function openObject(nav: string, kind: string, name: string): Promise<void> {
  await openResource(nav, kind);
  await searchResources(name);
  await byTestId(rowId(NS, name)).click();
  await shown("detail-drawer");
  await until(async () => (await byTestId("detail-title").getText()) === name, `the drawer never showed ${name}`);
}

async function moreActions(item: string): Promise<void> {
  await pointerClick(await shown("detail-more-actions"));
  await clickWhenShown(`menu-item-${item}`);
  await gone(`menu-item-${item}`);
}

async function appField(name: string, jsonpath: string): Promise<string> {
  return kubectl(["-n", NS, "get", "application", name, "-o", `jsonpath={${jsonpath}}`]);
}

async function drawerText(): Promise<string> {
  return byTestId("detail-drawer").getText();
}

/** Clears every Application's finalizers: no controller runs to remove them. */
async function releaseApplications(): Promise<void> {
  const names = await kubectl(["-n", NS, "get", "applications", "-o", "name"]).catch(() => "");
  for (const name of names.split("\n").filter(Boolean)) {
    await kubectl(["-n", NS, "patch", name, "--type=merge", "-p", '{"metadata":{"finalizers":null}}'])
      .catch(() => undefined);
  }
}

describe("Argo CD on the kind cluster", () => {
  before(async () => {
    await releaseApplications();
    await createTestNamespace(NS);
    await kubectl(["apply", "-f", "-"], OBJECTS);
    await kubectl([
      "-n", NS, "patch", "applicationset", "teams", "--subresource=status", "--type=merge",
      "-p", JSON.stringify(TEAMS_STATUS),
    ]);
    await openCluster(KIND);
  });

  after(async () => {
    await releaseApplications();
    await deleteTestNamespace(NS);
  });

  it("lists Applications in their own section with the Argo CD columns", async () => {
    await shown("nav-section-argocd");
    for (const plural of ["applications", "applicationsets", "appprojects"]) {
      await shown(`nav-item-argoproj.io-${plural}`);
    }
    await openResource(APPS, "Application");
    await searchResources("guestbook");
    const row = await shown(rowId(NS, "guestbook"));
    await until(async () => {
      const text = await row.getText();
      return ["default", "Synced", "Healthy", "4f2c9a1"].every((part) => text.includes(part));
    }, "the guestbook row never showed its Argo CD values");
  });

  it("shows sources, last operation, resources and history in the drawer", async () => {
    await openObject(APPS, "Application", "guestbook");
    for (const id of ["argocd-sources", "argocd-last-operation", "argocd-resources", "argocd-history"]) {
      await shown(id);
    }
    expect(await byTestId("argocd-resources").getText()).toContain("guestbook-ui");
    expect(await byTestId("argocd-history").getText()).toContain("9b07e3d");
  });

  it("shows ApplicationSet generators and AppProject sync windows", async () => {
    await openObject("nav-item-argoproj.io-applicationsets", "ApplicationSet", "teams");
    expect(await (await shown("appset-generators")).getText()).toContain("List");
    expect(await (await shown("appset-applications")).getText()).toContain("drop-a");
    await openObject("nav-item-argoproj.io-appprojects", "AppProject", "restricted");
    expect(await (await shown("appproject-windows")).getText()).toContain("0 22 * * *");
    await until(
      async () => (await byTestId("appproject-applications").getText()).includes("windowed"),
      "the restricted project never listed windowed",
    );
  });

  it("syncs with prune and shows the operation waiting for the controller", async () => {
    await openObject(APPS, "Application", "guestbook");
    await clickWhenShown("detail-action-argocd-sync");
    await clickWhenShown("argocd-sync-prune");
    const ok = await shown("argocd-sync-confirm");
    expect(await ok.getText()).toBe("Sync and prune");
    await ok.click();
    await gone("argocd-sync-dialog");
    await until(async () => (await appField("guestbook", ".operation.sync.prune")) === "true", "guestbook was never synced with prune");
    await until(
      async () => (await byTestId("argocd-operation-note").isExisting()) &&
        (await byTestId("argocd-operation-note").getText()).includes("waiting for the Argo CD controller"),
      "the waiting note never showed",
    );
    await pointerClick(await shown("detail-more-actions"));
    expect(await byTestId("menu-item-argocd-terminate").isExisting()).toBe(false);
    await browser.keys("Escape");
  });

  it("terminates a running operation and requests a refresh", async () => {
    await openObject(APPS, "Application", "busy");
    expect(await (await shown("argocd-operation-note")).getText()).toContain("ci-bot");
    await moreActions("argocd-terminate");
    await until(async () => (await appField("busy", ".status.operationState.phase")) === "Terminating", "busy was never marked Terminating");
    await until(async () => (await byTestId("argocd-operation-note").getText()).includes("terminating"), "the terminating note never showed");
    await openObject(APPS, "Application", "guestbook");
    await clickWhenShown("detail-action-argocd-refresh");
    await until(async () => (await drawerText()).includes("Requested (Normal)"), "the refresh never showed");
    expect(await appField("guestbook", ".metadata.annotations.argocd\\.argoproj\\.io/refresh")).toBe("normal");
  });

  it("locks the revision of a multi-source Application", async () => {
    await openObject(APPS, "Application", "platform");
    await clickWhenShown("detail-action-argocd-sync");
    expect(await (await shown("argocd-sync-revision")).isEnabled()).toBe(false);
    await dialogButton("Cancel").click();
    await gone("argocd-sync-dialog");
  });

  it("asks before syncing past sync windows it cannot check", async () => {
    await openObject(APPS, "Application", "windowed");
    await clickWhenShown("detail-action-argocd-sync");
    await clickWhenShown("argocd-sync-confirm");
    await until(
      async () => (await byTestId("argocd-windows-dialog").isExisting()) &&
        (await byTestId("argocd-windows-dialog").getText()).includes("0 22 * * *"),
      "the sync windows step never listed the window",
    );
    await clickWhenShown("argocd-windows-confirm");
    await gone("argocd-sync-dialog");
    await until(async () => (await appField("windowed", ".operation.sync")) !== "", "windowed was never synced");
  });

  it("refuses to roll back while auto-sync is on", async () => {
    await openObject(APPS, "Application", "autopilot");
    await moreActions("argocd-rollback");
    expect(await (await shown("argocd-rollback-refusal")).getText()).toContain("Auto-sync is on");
    expect(await (await shown("argocd-rollback-confirm")).isEnabled()).toBe(false);
    await dialogButton("Cancel").click();
    await gone("argocd-rollback-dialog");
  });

  it("deletes an Application and keeps its resources", async () => {
    await openResource(APPS, "Application");
    await searchResources("keep-me");
    await resourceRowMenu("keep-me", "delete");
    await clickWhenShown("argocd-delete-cascade-keep");
    const ok = await shown("delete-confirm");
    expect(await ok.getText()).toBe("Delete the Application");
    await ok.click();
    await gone(rowId(NS, "keep-me"), 30000);
  });

  it("bulk deletes Applications with their resources", async () => {
    await openResource(APPS, "Application");
    await searchResources("drop-");
    for (const name of ["drop-a", "drop-b"]) {
      await browser.$(`input[aria-label="Select ${NS}/${name}"]`).click();
    }
    await clickWhenShown("bulk-delete");
    expect(await (await shown("argocd-delete-dialog")).getText()).toContain("Delete 2 Applications?");
    const ok = await shown("delete-confirm");
    expect(await ok.getText()).toBe("Delete with resources");
    await ok.click();
    await gone("argocd-delete-dialog");
    for (const name of ["drop-a", "drop-b"]) {
      await until(async () => (await appField(name, ".metadata.deletionTimestamp")) !== "", `${name} was never deleted`);
    }
    await byTestId(rowId(NS, "drop-a")).click();
    await shown("detail-drawer");
    await until(async () => (await drawerText()).includes("deleting its resources too"), "the Deleting fact never showed");
  });
});
