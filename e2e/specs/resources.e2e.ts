import path from "node:path";
import {
  createTestNamespace,
  deleteTestNamespace,
  kubectl,
} from "../helpers/kube";
import {
  byTestId,
  clickWhenShown,
  expectResourceTitle,
  expectRows,
  expectRowsExactly,
  gone,
  openCluster,
  openResource,
  pointerClick,
  resourceRowMenu,
  rowId,
  rowIds,
  searchResources,
  shown,
  tableHeaders,
  toggleInCheckMenu,
} from "../helpers/ui";

const KIND = "kind-sextant-e2e";
const NS = "sextant-test-e2e";
const WORKLOADS = path.resolve(__dirname, "..", "fixtures", "workloads.yaml");
const PAUSE_IMAGE = "registry.k8s.io/pause:3.10";
const SECRET_VALUE = "ZTJlLXNlY3JldA==";
const SECRET_VALUE_DECODED = "e2e-secret";
/** The 1 s of spec F5, plus what WebDriver and kubectl take. */
const LIVE_UPDATE_LIMIT_MS = 1500;

const PODS = "nav-item-core-pods";
const CONFIGMAPS = "nav-item-core-configmaps";

/** The sections of F4 this phase ships, with every entry under each. */
const SIDEBAR: Record<string, string[]> = {
  nodes: ["core-nodes"],
  workloads: [
    "core-pods",
    "apps-deployments",
    "apps-daemonsets",
    "apps-statefulsets",
    "apps-replicasets",
    "batch-jobs",
    "batch-cronjobs",
  ],
  config: [
    "core-configmaps",
    "core-secrets",
    "core-resourcequotas",
    "core-limitranges",
    "autoscaling-horizontalpodautoscalers",
    "policy-poddisruptionbudgets",
    "scheduling.k8s.io-priorityclasses",
    "node.k8s.io-runtimeclasses",
    "coordination.k8s.io-leases",
    "admissionregistration.k8s.io-mutatingwebhookconfigurations",
    "admissionregistration.k8s.io-validatingwebhookconfigurations",
  ],
  network: [
    "core-services",
    "discovery.k8s.io-endpointslices",
    "networking.k8s.io-ingresses",
    "networking.k8s.io-ingressclasses",
    "networking.k8s.io-networkpolicies",
  ],
  storage: [
    "core-persistentvolumeclaims",
    "core-persistentvolumes",
    "storage.k8s.io-storageclasses",
  ],
  namespaces: ["core-namespaces"],
  events: ["core-events"],
  access: [
    "core-serviceaccounts",
    "rbac.authorization.k8s.io-clusterroles",
    "rbac.authorization.k8s.io-roles",
    "rbac.authorization.k8s.io-clusterrolebindings",
    "rbac.authorization.k8s.io-rolebindings",
  ],
  custom: ["apiextensions.k8s.io-customresourcedefinitions"],
};

async function createConfigMap(name: string): Promise<void> {
  await kubectl([
    "-n",
    NS,
    "create",
    "configmap",
    name,
    "--from-literal=key=value",
  ]);
}

async function configMapExists(name: string): Promise<boolean> {
  const found = await kubectl([
    "-n",
    NS,
    "get",
    "configmap",
    name,
    "--ignore-not-found",
    "-o",
    "name",
  ]);
  return found.trim() !== "";
}

/** Waits until a new object's creation second has passed, as timestamps have no finer unit. */
async function nextCreationSecond(configMap: string): Promise<void> {
  const created = await kubectl([
    "-n",
    NS,
    "get",
    "configmap",
    configMap,
    "-o",
    "jsonpath={.metadata.creationTimestamp}",
  ]);
  const after = Date.parse(created) + 1000;
  await browser.waitUntil(async () => Date.now() >= after, { interval: 50 });
}

async function clickSortHeader(header: string): Promise<void> {
  await byTestId("resource-table").$(`button=${header}`).click();
}

describe("resource browsing on a real cluster", () => {
  before(async () => {
    await createTestNamespace(NS);
    await kubectl(["apply", "-f", WORKLOADS]);
    await browser.waitUntil(
      async () => {
        const pods = await kubectl([
          "-n",
          NS,
          "get",
          "pods",
          "-l",
          "app=web",
          "-o",
          "name",
        ]);
        return pods.trim().split("\n").filter(Boolean).length === 2;
      },
      {
        timeout: 60000,
        interval: 500,
        timeoutMsg: "the web pods were never created",
      },
    );
    await openCluster(KIND);
  });

  after(async () => {
    await deleteTestNamespace(NS);
  });

  it("shows the F4 sidebar sections for an admin", async () => {
    await shown("nav-overview");
    await byTestId("nav-overview-workloads").waitForExist({ timeout: 15000 });
    for (const [section, items] of Object.entries(SIDEBAR)) {
      await byTestId(`nav-section-${section}`).waitForExist({ timeout: 15000 });
      for (const item of items) {
        expect(await byTestId(`nav-item-${item}`).isExisting()).toBe(true);
      }
    }
  });

  it("lists pods and shows a new one within 1 s of creation", async () => {
    await openResource(PODS, "Pod");
    await expectRows("kube-system pods", (ids) =>
      ids.some((id) => id.startsWith("resource-row-kube-system-")),
    );

    const row = byTestId(rowId(NS, "live-pod"));
    const started = Date.now();
    await kubectl([
      "-n",
      NS,
      "run",
      "live-pod",
      `--image=${PAUSE_IMAGE}`,
      "--restart=Never",
    ]);
    await browser.waitUntil(() => row.isExisting(), {
      timeout: 15000,
      interval: 50,
      timeoutMsg: "the new pod never appeared",
    });
    expect(Date.now() - started).toBeLessThan(LIVE_UPDATE_LIMIT_MS);
  });

  it("removes a row when the object is deleted", async () => {
    await shown(rowId(NS, "live-pod"));
    await kubectl([
      "-n",
      NS,
      "delete",
      "pod",
      "live-pod",
      "--grace-period=0",
      "--force",
    ]);
    await gone(rowId(NS, "live-pod"));
  });

  it("filters by namespace, and the filter survives navigating away and back", async () => {
    await openResource(PODS, "Pod");
    const inNamespace = (ids: string[]) =>
      ids.length > 0 && ids.every((id) => id.startsWith(`resource-row-${NS}-`));

    await toggleInCheckMenu("namespace-filter", [`namespace-option-${NS}`]);
    await expectRows(`only pods of ${NS}`, inNamespace);
    expect(await byTestId("namespace-filter").getText()).toBe(NS);

    await openResource(CONFIGMAPS, "ConfigMap");
    await expectRows(`only config maps of ${NS}`, inNamespace);

    await openResource(PODS, "Pod");
    expect(await byTestId("namespace-filter").getText()).toBe(NS);
    await expectRows(`only pods of ${NS} again`, inNamespace);
  });

  it("searches by name and by label", async () => {
    await openResource(PODS, "Pod");

    await searchResources("app=web");
    await expectRows("the two web pods", (ids) => {
      return (
        ids.length === 2 &&
        ids.every((id) => id.startsWith(`resource-row-${NS}-web-`))
      );
    });

    await searchResources("once");
    await expectRows("the pod of the job", (ids) => {
      return ids.length === 1 && ids[0].startsWith(`resource-row-${NS}-once-`);
    });

    await searchResources("no-such-object");
    await expectRowsExactly([]);
  });

  it("sorts by age and by name", async () => {
    await createConfigMap("sort-z-older");
    await nextCreationSecond("sort-z-older");
    await createConfigMap("sort-a-newer");
    const older = rowId(NS, "sort-z-older");
    const newer = rowId(NS, "sort-a-newer");

    await openResource(CONFIGMAPS, "ConfigMap");
    await searchResources("sort-");
    await expectRows("both config maps", (ids) => ids.length === 2);

    await clickSortHeader("Name");
    await expectRowsExactly([newer, older]);
    await clickSortHeader("Name");
    await expectRowsExactly([older, newer]);

    // Ascending age puts the youngest first.
    await clickSortHeader("Age");
    await expectRowsExactly([newer, older]);
    await clickSortHeader("Age");
    await expectRowsExactly([older, newer]);
  });

  it("hides and restores a column", async () => {
    await openResource(CONFIGMAPS, "ConfigMap");
    await searchResources("");
    await shown(rowId(NS, "app-config"));
    expect(await tableHeaders()).toContain("Namespace");

    await toggleInCheckMenu("columns-menu", ["column-option-namespace"]);
    await browser.waitUntil(
      async () => !(await tableHeaders()).includes("Namespace"),
      {
        timeoutMsg: "the column stayed",
      },
    );

    // The choice is kept per kind.
    await openResource(PODS, "Pod");
    await expectRows("some pods", (ids) => ids.length > 0);
    expect(await tableHeaders()).toContain("Namespace");
    await openResource(CONFIGMAPS, "ConfigMap");
    await shown(rowId(NS, "app-config"));
    expect(await tableHeaders()).not.toContain("Namespace");

    await toggleInCheckMenu("columns-menu", ["column-option-namespace"]);
    await browser.waitUntil(
      async () => (await tableHeaders()).includes("Namespace"),
      {
        timeoutMsg: "the column never came back",
      },
    );
  });

  it("opens the drawer with metadata, labels, owner link and events", async () => {
    await openResource(PODS, "Pod");
    await searchResources("app=web");
    await expectRows("the two web pods", (ids) => ids.length === 2);
    const [row] = await rowIds();
    const podName = row.slice(`resource-row-${NS}-`.length);

    await byTestId(row).click();
    await shown("detail-drawer");
    expect(await byTestId("detail-title").getText()).toContain(podName);
    const uid = await kubectl([
      "-n",
      NS,
      "get",
      "pod",
      podName,
      "-o",
      "jsonpath={.metadata.uid}",
    ]);
    const drawer = await byTestId("detail-drawer").getText();
    expect(drawer).toContain(NS);
    expect(drawer).toContain(uid);
    expect(await byTestId("detail-labels").getText()).toContain("app=web");
    await pointerClick(await byTestId("detail-drawer").$("button=Events"));
    await browser.waitUntil(
      async () =>
        (await shown("detail-events"))
          .getText()
          .then((text) => text.includes("Scheduled")),
      { timeout: 15000, timeoutMsg: "the pod's events never showed" },
    );

    await pointerClick(await byTestId("detail-drawer").$("button=Overview"));
    await clickWhenShown("detail-owner-link");
    await expectResourceTitle("ReplicaSet");
    await shown("detail-drawer");
    await browser.waitUntil(
      async () => (await byTestId("detail-title").getText()).includes("web-"),
      { timeoutMsg: "the drawer never showed the ReplicaSet" },
    );
    await clickWhenShown("detail-close");
    await gone("detail-drawer");
  });

  it("back and forward navigate between resource views", async () => {
    await openResource(PODS, "Pod");
    await openResource(CONFIGMAPS, "ConfigMap");

    await browser.keys(["Alt", "ArrowLeft"]);
    await expectResourceTitle("Pod");

    await browser.keys(["Alt", "ArrowRight"]);
    await expectResourceTitle("ConfigMap");
  });

  it("deletes one object after confirmation and bulk deletes two", async () => {
    for (const name of ["del-one", "del-two", "del-three"])
      await createConfigMap(name);
    await openResource(CONFIGMAPS, "ConfigMap");
    await searchResources("del-");
    await expectRows("the three config maps", (ids) => ids.length === 3);

    await resourceRowMenu("del-one", "delete");
    await shown("delete-confirm");
    expect(await configMapExists("del-one")).toBe(true);
    await clickWhenShown("delete-confirm");
    await gone(rowId(NS, "del-one"));
    await gone("delete-confirm");
    expect(await configMapExists("del-one")).toBe(false);

    for (const name of ["del-two", "del-three"]) {
      await browser.$(`input[aria-label="Select ${NS}/${name}"]`).click();
    }
    await browser.waitUntil(
      async () => (await byTestId("bulk-delete").getText()) === "Delete (2)",
      { timeoutMsg: "the bulk delete button never counted two" },
    );
    await clickWhenShown("bulk-delete");
    await clickWhenShown("delete-confirm");
    await gone(rowId(NS, "del-two"));
    await gone(rowId(NS, "del-three"));
    expect(await configMapExists("del-two")).toBe(false);
    expect(await configMapExists("del-three")).toBe(false);
  });

  it("shows Secret names but the value is not in page content", async () => {
    await openResource("nav-item-core-secrets", "Secret");
    await shown(rowId(NS, "app-secret"));

    const leaks = async () => {
      const page: string = await browser.execute(
        () => document.documentElement.outerHTML,
      );
      return page.includes(SECRET_VALUE) || page.includes(SECRET_VALUE_DECODED);
    };
    expect(await byTestId("resource-table").getText()).toContain("app-secret");
    expect(await leaks()).toBe(false);

    await byTestId(rowId(NS, "app-secret")).click();
    await shown("detail-drawer");
    await browser.waitUntil(
      async () =>
        (await byTestId("detail-title").getText()).includes("app-secret"),
      { timeoutMsg: "the drawer never showed the Secret" },
    );
    expect(await leaks()).toBe(false);
    await clickWhenShown("detail-close");
  });

  it("updates a changed row live and keeps the age column ticking", async () => {
    await createConfigMap("live-row");
    await openResource(CONFIGMAPS, "ConfigMap");
    await searchResources("tier=blue");
    await expectRowsExactly([]);

    const row = rowId(NS, "live-row");
    const started = Date.now();
    await kubectl([
      "-n",
      NS,
      "label",
      "configmap",
      "live-row",
      "tier=blue",
    ]);
    await browser.waitUntil(() => byTestId(row).isExisting(), {
      timeout: 15000,
      interval: 50,
      timeoutMsg: "the changed row never matched its new label",
    });
    expect(Date.now() - started).toBeLessThan(LIVE_UPDATE_LIMIT_MS);

    // The age is drawn from the clock, so it moves without any event.
    const before = await byTestId(row).getText();
    await browser.waitUntil(async () => (await byTestId(row).getText()) !== before, {
      timeout: 30000,
      timeoutMsg: "the age column never changed",
    });
  });

  it("shows annotations and conditions in the drawer, and updates it live", async () => {
    await kubectl([
      "-n",
      NS,
      "annotate",
      "configmap",
      "live-row",
      "note=first",
      "--overwrite",
    ]);
    await openResource(CONFIGMAPS, "ConfigMap");
    await searchResources("live-row");
    await byTestId(rowId(NS, "live-row")).click();
    await shown("detail-drawer");
    await browser.waitUntil(
      async () =>
        (await shown("detail-annotations")).getText().then((t) => t.includes("note=first")),
      { timeoutMsg: "the annotation never showed" },
    );

    // The drawer follows the object while it is open.
    await kubectl([
      "-n",
      NS,
      "annotate",
      "configmap",
      "live-row",
      "note=second",
      "--overwrite",
    ]);
    await browser.waitUntil(
      async () =>
        (await byTestId("detail-annotations").getText()).includes("note=second"),
      { timeout: 15000, timeoutMsg: "the open drawer never updated" },
    );

    // Pods carry status conditions.
    await clickWhenShown("detail-close");
    await openResource(PODS, "Pod");
    await searchResources("app=web");
    await expectRows("the two web pods", (ids) => ids.length === 2);
    const [pod] = await rowIds();
    await byTestId(pod).click();
    await shown("detail-conditions");
    expect(await byTestId("detail-conditions").getText()).toContain("Ready");
    await clickWhenShown("detail-close");
  });

  it("navigates back and forward with the mouse buttons", async () => {
    await openResource(PODS, "Pod");
    await openResource(CONFIGMAPS, "ConfigMap");
    const press = (button: number) =>
      browser.execute((b) => {
        window.dispatchEvent(
          new MouseEvent("mouseup", { button: b, cancelable: true }),
        );
      }, button);
    await press(3);
    await expectResourceTitle("Pod");
    await press(4);
    await expectResourceTitle("ConfigMap");
  });
});
