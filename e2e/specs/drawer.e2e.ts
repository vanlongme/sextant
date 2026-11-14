import path from "node:path";
import {
  createTestNamespace,
  deleteTestNamespace,
  kubectl,
} from "../helpers/kube";
import {
  byTestId,
  clickWhenShown,
  expectRows,
  gone,
  openCluster,
  openResource,
  rowId,
  rowIds,
  searchResources,
  shown,
} from "../helpers/ui";

const KIND = "kind-skopos-e2e";
const NS = "skopos-test-drawer";
const FIXTURE = path.resolve(__dirname, "..", "fixtures", "drawer.yaml");
const PODS = "nav-item-core-pods";
const SECRET_VALUE = "drawer-hidden-value";

const until = (
  check: () => Promise<boolean>,
  timeoutMsg: string,
  timeout = 30000,
) => browser.waitUntil(check, { timeout, interval: 250, timeoutMsg });

/** Waits until the drawer's band shows `kind` and a title that passes `title`. */
async function showing(
  kind: string,
  title: (text: string) => boolean,
  what: string,
): Promise<void> {
  let seen = "nothing";
  await browser
    .waitUntil(
      async () => {
        // Both texts are read in one script: WebKitWebDriver mixes up two getText calls in a row.
        const [kindText, titleText] = await browser.execute(() => {
          const text = (id: string) =>
            document.querySelector(`[data-testid="${id}"]`)?.textContent ??
            null;
          return [text("detail-kind"), text("detail-title")];
        });
        if (kindText === null || titleText === null) return false;
        seen = `${kindText} / ${titleText}`;
        return kindText === kind && title(titleText);
      },
      { timeout: 30000, interval: 250 },
    )
    .catch(() => {
      throw new Error(`the drawer never showed ${what}; it showed ${seen}`);
    });
}

/** A link of the drawer, by the section it sits in and its target key. */
function link(section: string, target: string) {
  return $(
    `[data-testid="${section}"] [data-target${target.endsWith("/") ? "^" : ""}="${target}"]`,
  );
}

/** An element's box in CSS pixels, measured in the page. */
function rect(testId: string) {
  return browser.execute((id) => {
    const r = document
      .querySelector(`[data-testid="${id}"]`)
      ?.getBoundingClientRect();
    return r
      ? { top: r.top, right: r.right, bottom: r.bottom, width: r.width }
      : null;
  }, testId);
}

/** The drawer's section toggles, top to bottom. */
function sectionToggles(): Promise<string[]> {
  return browser.execute(() =>
    Array.from(
      document.querySelectorAll(
        '[data-testid="detail-drawer"] [data-testid^="detail-section-toggle-"]',
      ),
    ).map((el) => el.getAttribute("data-testid") ?? ""),
  );
}

/** True when the page holds the Secret's value, plain or base64. */
async function leaks(): Promise<boolean> {
  const page: string = await browser.execute(
    () => document.documentElement.outerHTML,
  );
  return (
    page.includes(SECRET_VALUE) ||
    page.includes(Buffer.from(SECRET_VALUE).toString("base64"))
  );
}

/** Lists the fixture's two Pods and returns their row ids. */
async function listPods(): Promise<string[]> {
  await openResource(PODS, "Pod");
  await searchResources("app=linked");
  await expectRows("the two linked pods", (ids) => ids.length === 2);
  return rowIds();
}

/** Opens the drawer of the fixture's `index`th Pod and returns its name. */
async function openPod(index: number): Promise<string> {
  const row = (await listPods())[index];
  const name = row.slice(`resource-row-${NS}-`.length);
  await byTestId(row).click();
  await showing("Pod", (t) => t.includes(name), `Pod ${name}`);
  return name;
}

async function closeDrawer(): Promise<void> {
  await clickWhenShown("detail-close");
  await gone("detail-drawer");
}

describe("the details drawer on a real cluster", () => {
  before(async () => {
    await createTestNamespace(NS);
    await kubectl(["apply", "-f", FIXTURE]);
    await kubectl([
      "-n",
      NS,
      "rollout",
      "status",
      "deployment/linked",
      "--timeout=120s",
    ]);
    await openCluster(KIND);
  });

  after(async () => {
    await deleteTestNamespace(NS);
  });

  it("floats 8 px inside the list over a dim, and leaves the table its width", async () => {
    const [row] = await listPods();
    const before = await rect("resource-table");
    await byTestId(row).click();
    await shown("detail-drawer");
    await shown("detail-dim");
    // The drawer slides in, so it is measured once it rests.
    await until(async () => {
      const screen = await rect("resource-screen");
      const drawer = await rect("detail-drawer");
      return (
        screen !== null &&
        drawer !== null &&
        Math.abs(drawer.top - screen.top - 8) <= 1 &&
        Math.abs(screen.right - drawer.right - 8) <= 1 &&
        Math.abs(screen.bottom - drawer.bottom - 8) <= 1
      );
    }, "the drawer never rested 8 px inside the list");
    expect((await rect("resource-table"))?.width).toBe(before?.width);
    await closeDrawer();
  });

  it("shows a Pod's six sections in order and keeps a collapsed one collapsed", async () => {
    await openPod(0);
    expect(await sectionToggles()).toEqual([
      "detail-section-toggle-summary",
      "detail-section-toggle-relations",
      "detail-section-toggle-volumes",
      "detail-section-toggle-scheduling",
      "detail-section-toggle-containers",
      "detail-section-toggle-metadata",
    ]);
    const expanded = () =>
      byTestId("detail-section-toggle-volumes").getAttribute("aria-expanded");
    await clickWhenShown("detail-section-toggle-volumes");
    await until(
      async () => (await expanded()) === "false",
      "Volumes never collapsed",
    );
    await closeDrawer();
    await openPod(1);
    expect(await expanded()).toBe("false");
    await clickWhenShown("detail-section-toggle-volumes");
    await until(
      async () => (await expanded()) === "true",
      "Volumes never expanded again",
    );
    await closeDrawer();
  });

  it("follows the Node, ConfigMap and Namespace links, and Back returns", async () => {
    const pod = await openPod(0);
    const node = link("detail-relations", "/nodes//");
    await node.waitForDisplayed({ timeout: 15000 });
    await node.click();
    await showing("Node", () => true, "the Node");
    expect(await byTestId("detail-back").getAttribute("aria-label")).toBe(
      `Back to ${pod}`,
    );
    await clickWhenShown("detail-back");
    await showing("Pod", (t) => t.includes(pod), "the Pod after Back");
    expect(await byTestId("detail-back").isExisting()).toBe(false);

    await link("detail-volumes", `/configmaps/${NS}/linked-config`).click();
    await showing("ConfigMap", (t) => t === "linked-config", "the ConfigMap");
    expect(await (await shown("configmap-input-greeting")).getValue()).toBe(
      "hello-linked",
    );
    // The Namespace is linked from Relations and from Metadata: the first is followed.
    const [namespace] = await $$(
      `[data-testid="detail-drawer"] [data-target="/namespaces//${NS}"]`,
    );
    await namespace.click();
    await showing("Namespace", (t) => t === NS, "the Namespace");

    await clickWhenShown("detail-back");
    await showing(
      "ConfigMap",
      (t) => t === "linked-config",
      "the ConfigMap after Back",
    );
    await clickWhenShown("detail-back");
    await showing("Pod", (t) => t.includes(pod), "the Pod after two Backs");
    await closeDrawer();
  });

  it("a row click shows that Pod and forgets the linked objects", async () => {
    await openPod(0);
    const [, other] = await rowIds();
    await link("detail-volumes", `/configmaps/${NS}/linked-config`).click();
    await showing("ConfigMap", (t) => t === "linked-config", "the ConfigMap");
    await shown("detail-back");
    await byTestId(other).click();
    const name = other.slice(`resource-row-${NS}-`.length);
    await showing("Pod", (t) => t.includes(name), `Pod ${name}`);
    expect(await byTestId("detail-back").isExisting()).toBe(false);
    await closeDrawer();
  });

  it("closes with Escape from a row, and with the X", async () => {
    const pod = await openPod(0);
    await browser.execute(
      (id) =>
        document.querySelector<HTMLElement>(`[data-testid="${id}"]`)?.focus(),
      rowId(NS, pod),
    );
    await browser.keys("Escape");
    await gone("detail-drawer");
    await openPod(0);
    await closeDrawer();
  });

  it("shows the linked Secret's keys masked, and never its value", async () => {
    await openPod(0);
    expect(await leaks()).toBe(false);
    await link("detail-volumes", `/secrets/${NS}/linked-secret`).click();
    await showing("Secret", (t) => t === "linked-secret", "the Secret");
    expect(await (await shown("secret-value-password")).getText()).toBe(
      "••••••",
    );
    expect(await leaks()).toBe(false);
    await closeDrawer();
  });

  it("shows a Deployment's service account and its template's volumes", async () => {
    await openResource("nav-item-apps-deployments", "Deployment");
    await searchResources("linked");
    await byTestId(rowId(NS, "linked")).click();
    await showing("Deployment", (t) => t === "linked", "the Deployment");
    await link(
      "detail-relations",
      `/serviceaccounts/${NS}/linked`,
    ).waitForDisplayed({
      timeout: 15000,
    });
    const volumes = await (await shown("detail-volumes")).getText();
    for (const part of ["linked-config", "linked-secret", "scratch"]) {
      expect(volumes).toContain(part);
    }
    await closeDrawer();
  });

  it("says so when the shown linked object is deleted", async () => {
    await openPod(0);
    await link("detail-volumes", `/configmaps/${NS}/linked-config`).click();
    await showing("ConfigMap", (t) => t === "linked-config", "the ConfigMap");
    await kubectl([
      "-n",
      NS,
      "delete",
      "configmap",
      "linked-config",
      "--wait=true",
    ]);
    await shown("detail-removed", 30000);
    await closeDrawer();
  });
});
