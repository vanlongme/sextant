import fs from "node:fs";
import path from "node:path";
import {
  createTestNamespace,
  deleteTestNamespace,
  kubectl,
} from "../../helpers/kube";
import {
  clickWhenShown,
  closeDockTabs,
  editorContaining,
  gone,
  openCluster,
  openResource,
  resourceRowMenu,
  rowId,
  searchResources,
  shown,
} from "../../helpers/ui";

const KIND = "kind-skopos-e2e";
const NS = "skopos-test-screens";
// The worktree's git-ignored tmp/, three levels up from e2e/specs/screens.
const OUT = path.resolve(__dirname, "../../../tmp/screens");

async function setTheme(theme: "light" | "dark"): Promise<void> {
  await browser.execute((t) => {
    document.documentElement.dataset.theme = t;
    // Transitions do not advance under the WebKit driver; without this the
    // light shots keep the dark colours of transitioned controls.
    if (!document.getElementById("shot-no-transition")) {
      const style = document.createElement("style");
      style.id = "shot-no-transition";
      style.textContent = "*,*::before,*::after{transition:none!important;animation:none!important}";
      document.head.appendChild(style);
    }
  }, theme);
  // One frame for Monaco's theme observer and the repaint.
  await browser.pause(300);
}

async function shoot(name: string): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    await setTheme(theme);
    await browser.saveScreenshot(path.join(OUT, `${name}-${theme}.png`));
  }
}

describe("screens", () => {
  before(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    await createTestNamespace(NS);
    await kubectl([
      "-n",
      NS,
      "create",
      "configmap",
      "screens",
      "--from-literal=key=value",
    ]);
  });

  after(async () => {
    await deleteTestNamespace(NS);
  });

  it("catalog", async () => {
    await clickWhenShown("nav-catalog");
    await shown(`catalog-row-${KIND}`, 30000);
    await shoot("catalog");
  });

  it("cluster overview", async () => {
    await openCluster(KIND);
    await shoot("cluster-overview");
  });

  it("pods table with a pod drawer", async () => {
    await openResource("nav-item-core-pods", "Pod");
    // kind's etcd static pod is always there, with a container named etcd.
    await searchResources("component=etcd");
    await $('[data-testid^="resource-row-"]').click();
    await shown("detail-container-etcd");
    await shoot("pods-drawer");
    await clickWhenShown("detail-close");
    await gone("detail-drawer");
  });

  it("dock with a YAML tab", async () => {
    await openResource("nav-item-core-configmaps", "ConfigMap");
    await searchResources("screens");
    await shown(rowId(NS, "screens"));
    await resourceRowMenu("screens", "edit");
    await editorContaining("key: value");
    await shoot("dock-yaml");
    await closeDockTabs();
  });

  it("delete dialog", async () => {
    await resourceRowMenu("screens", "delete");
    await shown("delete-confirm");
    await shoot("delete-dialog");
    await browser.keys("Escape");
    await gone("delete-confirm");
  });

  it("preferences", async () => {
    await clickWhenShown("nav-preferences");
    await browser.pause(400);
    await shoot("preferences");
  });
});
