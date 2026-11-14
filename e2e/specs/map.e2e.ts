import { kubectl } from "../helpers/kube";
import {
  byTestId,
  clickWhenShown,
  gone,
  openCluster,
  openResource,
  pointerClick,
  rowId,
  searchResources,
  shown,
  tableHeaders,
} from "../helpers/ui";

// e2e/helpers/fixtures.ts creates these objects before the app starts (spec E §18.3).
const KIND = "kind-skopos-e2e";
const NS = "skopos-e2e-map";
const GATEWAY_GROUP = "gateway.networking.k8s.io";

const DEPLOYMENT = `Deployment/${NS}/web`;
// Ids ending in "-" are prefixes of generated names.
const REPLICA_SET = `ReplicaSet/${NS}/web-`;
const POD = `Pod/${NS}/web-`;
const SERVICE = `Service/${NS}/web`;
const INGRESS = `Ingress/${NS}/web`;
const ROUTE = `HTTPRoute/${NS}/web`;
const GATEWAY = `Gateway/${NS}/edge`;
const CLASS = `GatewayClass//${NS}`;
const CONFIG = `ConfigMap/${NS}/web-config`;
const SECRET = `Secret/${NS}/web-secret`;
const ACCOUNT = `ServiceAccount/${NS}/web`;
const CLAIM = `PersistentVolumeClaim/${NS}/web-data`;
const OBJECTS = [
  DEPLOYMENT,
  REPLICA_SET,
  POD,
  SERVICE,
  INGRESS,
  ROUTE,
  GATEWAY,
  CLASS,
  CONFIG,
  SECRET,
  ACCOUNT,
  CLAIM,
];

const until = (
  check: () => Promise<boolean>,
  timeoutMsg: string,
  timeout = 30000,
) => browser.waitUntil(check, { timeout, interval: 500, timeoutMsg });

const idMatch = (attr: string, id: string) =>
  id.endsWith("-") ? `[${attr}^="${id}"]` : `[${attr}="${id}"]`;

function node(id: string) {
  return $(`[data-testid="map-node"]${idMatch("data-id", id)}`);
}

function edge(from: string, rel: string, to: string) {
  return $(
    `[data-testid="map-edge"]${idMatch("data-from", from)}[data-rel="${rel}"]${idMatch("data-to", to)}`,
  );
}

/**
 * Waits until an element stays put for one poll. Opening the details pane narrows the
 * canvas, and the view refits on resize (spec E §8.2), so the nodes move just after a
 * selection; a click measured before that lands where the node was.
 */
async function stopped(element: WebdriverIO.Element): Promise<void> {
  let last = "";
  await browser.waitUntil(
    async () => {
      const now = JSON.stringify([
        await element.getLocation(),
        await element.getSize(),
      ]);
      const same = now === last;
      last = now;
      return same;
    },
    { timeout: 10000, interval: 250, timeoutMsg: "the node kept moving" },
  );
}

/**
 * Clicks a node's ring, so the click lands on the node and not between its parts,
 * and waits for the details pane of "‹Kind› ‹name›".
 */
async function select(id: string, label: string): Promise<void> {
  await node(id).waitForExist({ timeout: 30000 });
  const ring = await node(id).$("circle");
  await stopped(ring);
  await pointerClick(ring);
  await until(
    async () => {
      const details = byTestId("map-details");
      return (
        (await details.isExisting()) &&
        (await details.getAttribute("aria-label")) === label
      );
    },
    `selecting ${id} never showed the details of ${label}`,
  );
}

async function summaryCount(): Promise<number> {
  const text = await (await shown("map-summary")).getText();
  return Number.parseInt(text.replace(/,/g, ""), 10);
}

async function focus(): Promise<string | null> {
  const page = byTestId("map-page");
  return (await page.isExisting()) ? page.getAttribute("data-focus") : null;
}

const opacity = async (id: string) =>
  Number((await node(id).getCSSProperty("opacity")).value);

/** Opens a popover of the filters row, unless it is open. */
async function openFilter(which: "ns" | "kind"): Promise<void> {
  if (!(await byTestId(`map-${which}-popover`).isExisting())) {
    await clickWhenShown(`map-${which}-filter`);
  }
  await shown(`map-${which}-popover`);
}

/** Closes a popover with Escape from its search box (spec H59). */
async function closeFilter(which: "ns" | "kind"): Promise<void> {
  await clickWhenShown(`map-${which}-search`);
  await browser.keys("Escape");
  await gone(`map-${which}-popover`);
}

/** Checks or unchecks a box of an open popover. */
async function setBox(testId: string, checked: boolean): Promise<void> {
  const box = await shown(testId);
  if ((await box.isSelected()) !== checked) await box.click();
  await browser.waitUntil(async () => (await byTestId(testId).isSelected()) === checked, {
    timeout: 5000,
    timeoutMsg: `${testId} never turned ${checked ? "on" : "off"}`,
  });
}

/** Shows only `namespace`: Clear hides the listed namespaces, then its box shows it. */
async function onlyNamespace(namespace: string): Promise<void> {
  await openFilter("ns");
  if (await byTestId("map-ns-clear").isEnabled()) {
    await clickWhenShown("map-ns-clear");
  }
  await setBox(`map-ns-option-${namespace}`, true);
  await closeFilter("ns");
  await until(
    async () => (await byTestId("map-ns-filter").getText()) === namespace,
    `the Namespaces filter never showed only ${namespace}`,
  );
}

describe("resource map", () => {
  let pod = "";

  before(async () => {
    pod = (
      await kubectl([
        "-n",
        NS,
        "get",
        "pods",
        "-l",
        "app=web",
        "-o",
        "jsonpath={.items[0].metadata.name}",
      ])
    ).trim();
    await openCluster(KIND);
  });

  it("draws the fixture's objects and relations from the sidebar", async () => {
    await clickWhenShown("nav-map");
    await shown("map-ns-filter", 60000);
    // Only the fixture's namespace stays shown, so the drawing stays small.
    await onlyNamespace(NS);
    for (const id of OBJECTS) {
      await node(id).waitForExist({
        timeout: 30000,
        timeoutMsg: `the map never drew ${id}`,
      });
    }
    // Grouped draws ownership as boxes, so the lines are read from Layered.
    await clickWhenShown("map-layout-layered");
    const relations: [string, string, string][] = [
      [DEPLOYMENT, "owns", REPLICA_SET],
      [REPLICA_SET, "owns", POD],
      [SERVICE, "selects", POD],
      [INGRESS, "routes", SERVICE],
      [GATEWAY, "routes", ROUTE],
      [ROUTE, "routes", SERVICE],
      [GATEWAY, "class", CLASS],
      [POD, "mounts", CONFIG],
      [POD, "env", SECRET],
      [POD, "runsAs", ACCOUNT],
      [POD, "claims", CLAIM],
    ];
    for (const [from, rel, to] of relations) {
      await edge(from, rel, to).waitForExist({
        timeout: 15000,
        timeoutMsg: `no ${rel} edge from ${from} to ${to}`,
      });
    }
  });

  it("fills the page under the toolbar", async () => {
    const canvas = await shown("map-canvas");
    const { height } = await canvas.getSize();
    const viewport = await browser.execute(() => window.innerHeight);
    // The toolbar, the filters row and window chrome take well under half of the window.
    expect(height).toBeGreaterThan(viewport / 2);
  });

  it("shows the Gateway and its class waiting for a controller", async () => {
    expect(await node(GATEWAY).getAttribute("data-status")).toBe("warning");
    await select(GATEWAY, "Gateway edge");
    await until(
      async () =>
        (await byTestId("map-details").getText()).includes(
          "Not programmed yet",
        ),
      "the Gateway never read Not programmed yet",
    );
    await select(CLASS, `GatewayClass ${NS}`);
    await until(
      async () =>
        (await byTestId("map-details").getText()).includes(
          "Waiting for the controller",
        ),
      "the GatewayClass never read Waiting for the controller",
    );
  });

  it("shows the Pod's facts and connections, and a row selects the Service", async () => {
    await select(POD, `Pod ${pod}`);
    const labels = await browser.execute(() =>
      Array.from(document.querySelectorAll('[data-testid="map-fact"]')).map(
        (el) => el.getAttribute("data-label"),
      ),
    );
    for (const label of ["Ready", "Restarts", "Node", "Age"]) {
      expect(labels).toContain(label);
    }
    const row = $(
      `[data-testid="map-connection"][data-id="${SERVICE}"][data-dir="in"]`,
    );
    await row.waitForExist({ timeout: 15000 });
    await row.click();
    await until(
      async () =>
        (await byTestId("map-details").getAttribute("aria-label")) ===
        "Service web",
      "the Service row never selected the Service",
    );
  });

  it("opens the Deployment's object map at 2 hops; 1 hop draws less; Back returns", async () => {
    await select(DEPLOYMENT, "Deployment web");
    await clickWhenShown("map-details-focus");
    await until(
      async () => (await focus()) === DEPLOYMENT,
      "the object map never opened",
    );
    expect(await (await byTestId("map-depth-2").$("input")).isSelected()).toBe(
      true,
    );
    await shown("map-summary");
    const twoHops = await summaryCount();
    await clickWhenShown("map-depth-1");
    await until(
      async () => (await summaryCount()) < twoHops,
      "1 hop never drew fewer resources",
    );
    await browser.back();
    await until(
      async () =>
        (await focus()) === null && (await byTestId("map-search").isExisting()),
      "Back never returned to the cluster map",
    );
  });

  it("draws the Pod drawer's Resource map, whose link opens the object map", async () => {
    await openResource("nav-item-core-pods", "Pod");
    await searchResources(pod);
    await clickWhenShown(rowId(NS, pod));
    await shown("detail-drawer");
    await pointerClick(await shown("detail-tab-map"));
    await shown("drawer-map", 30000);
    await until(
      async () =>
        (await $$('[data-testid="drawer-map"] [data-testid="map-node"]').length) >
        0,
      "the drawer's map never drew",
    );
    await clickWhenShown("drawer-map-open");
    await until(
      async () => (await focus()) === `Pod/${NS}/${pod}`,
      "the drawer's link never opened the Pod's object map",
    );
  });

  it("says so when the only shown namespace is hidden", async () => {
    await clickWhenShown("nav-map");
    await openFilter("ns");
    await setBox(`map-ns-option-${NS}`, false);
    await until(
      async () =>
        (await byTestId("map-empty").isExisting()) &&
        (await byTestId("map-empty").getText()) ===
          "All namespaces are hidden. Pick one above to draw the map.",
      "hiding the last namespace never said so",
    );
    await setBox(`map-ns-option-${NS}`, true);
    await closeFilter("ns");
    await shown("map-canvas", 30000);
  });

  it("hides kinds and bridges their links", async () => {
    await clickWhenShown("nav-map");
    await node(DEPLOYMENT).waitForExist({ timeout: 30000 });
    // Bridges are read from Layered, which draws every edge as a line.
    await clickWhenShown("map-layout-layered");

    // 1. ReplicaSets hidden: the Deployment owns its Pod through one.
    await openFilter("kind");
    await setBox("map-kind-option-ReplicaSet", false);
    await closeFilter("kind");
    await node(REPLICA_SET).waitForExist({ timeout: 15000, reverse: true });
    const owns = edge(DEPLOYMENT, "owns", POD);
    await owns.waitForExist({
      timeout: 15000,
      timeoutMsg: "no bridge from the Deployment to its Pod",
    });
    expect(await owns.getAttribute("data-via")).toBe("ReplicaSet");
    await select(DEPLOYMENT, "Deployment web");
    const row = $(
      `[data-testid="map-connection"]${idMatch("data-id", POD)}[data-via="ReplicaSet"]`,
    );
    await row.waitForExist({
      timeout: 15000,
      timeoutMsg: "the details never listed the Pod via ReplicaSet",
    });
    expect(await row.getText()).toContain("via ReplicaSet");
    await clickWhenShown("map-details-close");

    // 2. Pods hidden too. The graph's use edges start at Pods, so neither bridge meets a real edge.
    await openFilter("kind");
    await setBox("map-kind-option-Pod", false);
    await closeFilter("kind");
    const selects = edge(SERVICE, "selects", DEPLOYMENT);
    await selects.waitForExist({
      timeout: 15000,
      timeoutMsg: "no bridge from the Service to the Deployment",
    });
    expect(await selects.getAttribute("data-via")).toBe("Pod,ReplicaSet");
    const mounts = edge(DEPLOYMENT, "mounts", CONFIG);
    await mounts.waitForExist({
      timeout: 15000,
      timeoutMsg: "no bridge from the Deployment to its ConfigMap",
    });
    expect(await mounts.getAttribute("data-via")).toBe("Pod,ReplicaSet");

    // 3. The legend names bridges while one is drawn.
    await clickWhenShown("map-legend-toggle");
    await shown("map-legend-bridge");
    await clickWhenShown("map-legend-toggle");

    // 4. Every kind hidden.
    await openFilter("kind");
    await clickWhenShown("map-kind-clear");
    await until(
      async () =>
        (await byTestId("map-empty").isExisting()) &&
        (await byTestId("map-empty").getText()) ===
          "All kinds are hidden. Pick one in Kinds to draw the map.",
      "hiding every kind never said so",
    );

    // 5. A Kinds choice is kept when the page is opened again.
    await clickWhenShown("map-kind-select-all");
    await setBox("map-kind-option-ReplicaSet", false);
    await closeFilter("kind");
    await openResource("nav-item-core-pods", "Pod");
    await clickWhenShown("nav-map");
    await until(
      async () =>
        (await byTestId("map-kind-filter").isExisting()) &&
        (await byTestId("map-kind-filter").getAttribute("title")) === "Hidden: ReplicaSets",
      "the Kinds choice was not kept",
    );
    await edge(DEPLOYMENT, "owns", POD).waitForExist({
      timeout: 30000,
      timeoutMsg: "the kept choice drew no bridge",
    });

    // 6. Clear filters brings everything back; then the fixture's namespace alone again.
    await clickWhenShown("map-clear-filters");
    await gone("map-clear-filters");
    expect(await byTestId("map-kind-filter").getText()).toBe("All kinds");
    expect(await byTestId("map-ns-filter").getText()).toBe("All namespaces");
    await node(REPLICA_SET).waitForExist({ timeout: 30000 });
    await onlyNamespace(NS);
  });

  it("dims what the search misses, and each layout draws the fixture", async () => {
    await node(SECRET).waitForExist({ timeout: 30000 });
    await (await shown("map-search")).setValue("web-secret");
    await until(
      async () => (await opacity(DEPLOYMENT)) < 1,
      "the search never dimmed the Deployment",
    );
    expect(await opacity(SECRET)).toBe(1);
    await (await shown("map-search")).clearValue();
    for (const layout of ["grouped", "layered", "force"]) {
      await clickWhenShown(`map-layout-${layout}`);
      await until(
        async () =>
          (await byTestId(`map-layout-${layout}`).$("input")).isSelected(),
        `the ${layout} layout was never chosen`,
      );
      for (const id of OBJECTS) {
        await node(id).waitForExist({
          timeout: 15000,
          timeoutMsg: `${layout} never drew ${id}`,
        });
      }
    }
  });

  it("lists the Gateway's class and the HTTPRoute's parents", async () => {
    await openResource(`nav-item-${GATEWAY_GROUP}-gateways`, "Gateway");
    await until(
      async () => (await tableHeaders()).includes("Programmed"),
      "the Gateways list never showed its columns",
    );
    // The namespace and the class have the same name: the row shows it twice.
    await until(
      async () =>
        (await (await shown(rowId(NS, "edge"))).getText()).split(NS).length >=
        3,
      "the Gateway row never showed its class",
    );
    await openResource(`nav-item-${GATEWAY_GROUP}-httproutes`, "HTTPRoute");
    await until(
      async () =>
        (await (await shown(rowId(NS, "web"))).getText()).includes(
          `${NS}/edge`,
        ),
      "the HTTPRoute row never showed its parent",
    );
  });
});
