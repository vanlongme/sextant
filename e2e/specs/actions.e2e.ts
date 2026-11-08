import { createTestNamespace, deleteTestNamespace, kubectl } from "../helpers/kube";
import {
  byTestId, clickWhenShown, closeDockTabs, dialogButton, editorContaining, gone,
  openCluster, openResource, pointerClick, resourceRowMenu, rowId, searchResources, shown,
} from "../helpers/ui";

const KIND = "kind-skopos-e2e";
const NS = "skopos-test-actions";
const CLASSES = ["skopos-test-a", "skopos-test-b"];
const DEFAULT_KEY = "ingressclass.kubernetes.io/is-default-class";
const until = (check: () => Promise<boolean>, timeoutMsg: string) =>
  browser.waitUntil(check, { timeout: 60000, interval: 500, timeoutMsg });

const MANIFEST = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: ${NS}
spec:
  replicas: 1
  selector:
    matchLabels: { app: web }
  template:
    metadata:
      labels: { app: web }
    spec:
      terminationGracePeriodSeconds: 0
      containers:
        - name: main
          image: registry.k8s.io/pause:3.10
---
apiVersion: v1
kind: Pod
metadata:
  name: doomed
  namespace: ${NS}
spec:
  terminationGracePeriodSeconds: 30
  containers:
    - name: main
      image: registry.k8s.io/pause:3.10
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: held
  namespace: ${NS}
  finalizers: [skopos.test/hold]
data:
  mode: fast
---
apiVersion: batch/v1
kind: Job
metadata:
  name: batch
  namespace: ${NS}
spec:
  suspend: false
  template:
    spec:
      restartPolicy: Never
      terminationGracePeriodSeconds: 0
      containers:
        - name: main
          image: registry.k8s.io/pause:3.10
---
apiVersion: networking.k8s.io/v1
kind: IngressClass
metadata:
  name: skopos-test-a
  annotations:
    ${DEFAULT_KEY}: "true"
spec:
  controller: skopos.test/none
---
apiVersion: networking.k8s.io/v1
kind: IngressClass
metadata:
  name: skopos-test-b
spec:
  controller: skopos.test/none
`;

/** Lets go of the ConfigMap, so a failed run cannot keep the namespace from going. */
async function releaseHeld(): Promise<void> {
  await kubectl([
    "-n", NS, "patch", "configmap", "held", "--type=merge",
    "-p", '{"metadata":{"finalizers":null}}',
  ]).catch(() => undefined);
}

/** The default IngressClasses that are not this spec's own. */
async function otherDefaults(): Promise<string[]> {
  const list = JSON.parse(await kubectl(["get", "ingressclass", "-o", "json"]));
  return list.items
    .filter((c: any) => c.metadata.annotations?.[DEFAULT_KEY] === "true")
    .map((c: any) => c.metadata.name as string)
    .filter((name: string) => !CLASSES.includes(name));
}

async function isDefault(name: string): Promise<string> {
  const path = `{.metadata.annotations.${DEFAULT_KEY.replaceAll(".", "\\.")}}`;
  return (await kubectl(["get", "ingressclass", name, "-o", `jsonpath=${path}`])).trim();
}

async function jobSuspended(): Promise<string> {
  return (await kubectl(["-n", NS, "get", "job", "batch", "-o", "jsonpath={.spec.suspend}"])).trim();
}

async function theme(): Promise<string | undefined> {
  return browser.execute(() => document.documentElement.dataset.theme);
}

async function openDrawer(nav: string, kind: string, name: string): Promise<void> {
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

describe("object actions on the kind cluster", () => {
  let defaults: string[] = [];

  before(async () => {
    await releaseHeld();
    await kubectl(["delete", "ingressclass", ...CLASSES, "--ignore-not-found"]);
    defaults = await otherDefaults();
    await createTestNamespace(NS);
    await kubectl(["apply", "-f", "-"], MANIFEST);
    await kubectl(["-n", NS, "wait", "--for=condition=Ready", "pod/doomed", "--timeout=120s"]);
    await kubectl(["-n", NS, "rollout", "status", "deployment/web", "--timeout=120s"]);
    await openCluster(KIND);
  });

  after(async () => {
    await releaseHeld();
    await kubectl(["delete", "ingressclass", ...CLASSES, "--ignore-not-found"]);
    for (const name of defaults) {
      await kubectl(["annotate", "ingressclass", name, `${DEFAULT_KEY}=true`, "--overwrite"]);
    }
    await deleteTestNamespace(NS);
  });

  it("opens Edit YAML from the header and Scale from More actions", async () => {
    await openDrawer("nav-item-apps-deployments", "Deployment", "web");
    await clickWhenShown("detail-action-edit");
    await editorContaining("name: web");
    await closeDockTabs();
    await moreActions("scale");
    await shown("scale-replicas");
    await dialogButton("Cancel").click();
    await gone("scale-replicas");
  });

  it("copies the UID through the clipboard plugin", async () => {
    const copy = await shown("copy-uid");
    await copy.click();
    await until(async () => (await copy.getAttribute("aria-label")) === "Copied UID", "the UID was never copied");
    expect(await copy.getAttribute("title")).not.toContain("Could not copy");
    expect(await byTestId("detail-drawer").getText()).toContain("Copied");
  });

  it("force deletes a Pod from its drawer", async () => {
    await openDrawer("nav-item-core-pods", "Pod", "doomed");
    await moreActions("force-delete");
    await dialogButton("Force delete").click();
    await gone(rowId(NS, "doomed"), 30000);
    expect(await kubectl(["-n", NS, "get", "pods", "-o", "name"])).not.toContain("pod/doomed");
  });

  it("force finalizes a ConfigMap held by a finalizer", async () => {
    await kubectl(["-n", NS, "delete", "configmap", "held", "--wait=false"]);
    await openDrawer("nav-item-core-configmaps", "ConfigMap", "held");
    await until(async () => (await byTestId("detail-drawer").getText()).includes("Deleting since"), "the drawer never showed the deletion");
    await moreActions("force-finalize");
    await dialogButton("Force finalize").click();
    await gone(rowId(NS, "held"), 30000);
  });

  it("suspends and resumes a Job", async () => {
    await openResource("nav-item-batch-jobs", "Job");
    await searchResources("batch");
    await resourceRowMenu("batch", "suspend");
    await until(async () => (await jobSuspended()) === "true", "the Job was never suspended");
    await resourceRowMenu("batch", "resume");
    await until(async () => (await jobSuspended()) === "false", "the Job was never resumed");
  });

  it("makes another IngressClass the default", async () => {
    await openResource("nav-item-networking.k8s.io-ingressclasses", "IngressClass");
    await searchResources("skopos-test");
    await resourceRowMenu("skopos-test-b", "set-default");
    await until(async () => (await isDefault("skopos-test-b")) === "true", "skopos-test-b never became the default");
    expect(await isDefault("skopos-test-a")).not.toBe("true");
  });

  it("sets the theme with the Segmented control and its arrow keys", async () => {
    await clickWhenShown("nav-preferences");
    await clickWhenShown("prefs-theme-dark");
    await until(async () => (await theme()) === "dark", "the theme never turned dark");
    await browser.execute(() =>
      document.querySelector<HTMLInputElement>('[data-testid="prefs-theme-dark"] input')?.focus(),
    );
    await browser.keys("ArrowRight");
    await until(async () => (await theme()) === "light", "ArrowRight never chose Light");
    await clickWhenShown("prefs-theme-system");
  });
});
