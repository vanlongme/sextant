import path from "node:path";
import { createTestNamespace, deleteTestNamespace, kubectl } from "../helpers/kube";
import {
  byTestId, clickWhenShown, dialogButton, openCluster, openResource, resourceRowMenu,
  rowId, searchResources, shown,
} from "../helpers/ui";

const KIND = "kind-skopos-e2e";
const NS = "skopos-test-kinds";
const FIXTURE = path.resolve(__dirname, "..", "fixtures", "kinds.yaml");
const until = (check: () => Promise<boolean>, timeoutMsg: string) =>
  browser.waitUntil(check, { timeout: 60000, interval: 500, timeoutMsg });

describe("kinds on a real cluster", () => {
  before(async () => {
    await deleteTestNamespace(NS);
    await createTestNamespace(NS);
    await kubectl(["apply", "-f", FIXTURE]);
    await kubectl(["-n", NS, "rollout", "status", "deployment/steady", "--timeout=120s"]);
    await openCluster(KIND);
  });

  after(async () => {
    await deleteTestNamespace(NS);
  });

  it("shows kubectl status strings on pod rows", async () => {
    await openResource("nav-item-core-pods", "Pod");
    await searchResources("broken");
    const row = rowId(NS, "broken");
    await until(
      async () => /ImagePullBackOff|ErrImagePull/.test(await byTestId(row).getText()),
      "the broken pod never showed its waiting reason",
    );
    await searchResources("app=steady");
    await until(async () => (await $('[data-testid^="resource-row-"]').getText()).includes("Running"), "steady never ran");
  });

  it("shows a pod's containers without resolving Secret references", async () => {
    await openResource("nav-item-core-pods", "Pod");
    await searchResources("app=api");
    await $('[data-testid^="resource-row-"]').click();
    const container = await shown("detail-container-main");
    const text = await container.getText();
    expect(text).toContain("FROM_SECRET ← Secret creds / password");
    expect(text).toContain("readiness: tcp-socket :8080");
    expect(await browser.getPageSource()).not.toContain("e2e-hidden-value");
    await clickWhenShown("detail-close");
  });

  it("lists a deployment's pods in its panel", async () => {
    await openResource("nav-item-apps-deployments", "Deployment");
    await searchResources("steady");
    await byTestId(rowId(NS, "steady")).click();
    await until(async () => (await (await shown("detail-pods")).getText()).includes("steady-"), "no pod listed");
    await clickWhenShown("detail-close");
  });

  it("scales a deployment", async () => {
    await resourceRowMenu("steady", "scale");
    await (await shown("scale-replicas")).setValue("2");
    await clickWhenShown("scale-confirm");
    await until(
      async () => (await kubectl(["-n", NS, "get", "deployment", "steady", "-o", "jsonpath={.spec.replicas}"])) === "2",
      "the replica count never changed",
    );
    await until(async () => (await byTestId(rowId(NS, "steady")).getText()).includes("/2"), "the row never showed 2");
  });

  it("restarts a deployment", async () => {
    await resourceRowMenu("steady", "restart");
    await (await dialogButton("Restart")).click();
    await until(
      async () =>
        (await kubectl(["-n", NS, "get", "deployment", "steady", "-o", "jsonpath={.spec.template.metadata.annotations.kubectl\\.kubernetes\\.io/restartedAt}"])) !== "",
      "the restart annotation never appeared",
    );
  });

  it("evicts a pod and its controller replaces it", async () => {
    await kubectl(["-n", NS, "rollout", "status", "deployment/steady", "--timeout=120s"]);
    const before = (await kubectl(["-n", NS, "get", "pods", "-l", "app=steady", "-o", "jsonpath={.items[0].metadata.name}"])).trim();
    await openResource("nav-item-core-pods", "Pod");
    await searchResources(before);
    await resourceRowMenu(before, "evict");
    await (await dialogButton("Evict")).click();
    await until(
      async () => !(await kubectl(["-n", NS, "get", "pods", "-l", "app=steady", "-o", "name"])).includes(before),
      "the pod was never evicted",
    );
  });

  it("triggers, suspends and resumes a cronjob", async () => {
    await openResource("nav-item-batch-cronjobs", "CronJob");
    await searchResources("tick");
    await resourceRowMenu("tick", "trigger");
    await (await dialogButton("Trigger")).click();
    await until(async () => (await kubectl(["-n", NS, "get", "jobs", "-o", "name"])).includes("tick-manual-"), "no job appeared");
    const annotation = await kubectl(["-n", NS, "get", "jobs", "-o", "jsonpath={.items[0].metadata.annotations.cronjob\\.kubernetes\\.io/instantiate}"]);
    expect(annotation).toBe("manual");
    const owner = await kubectl(["-n", NS, "get", "jobs", "-o", "jsonpath={.items[0].metadata.ownerReferences[0].kind}"]);
    expect(owner).toBe("CronJob");

    await resourceRowMenu("tick", "suspend");
    await until(async () => (await byTestId(rowId(NS, "tick")).getText()).includes("Suspended"), "never suspended");
    await resourceRowMenu("tick", "resume");
    await until(async () => !(await byTestId(rowId(NS, "tick")).getText()).includes("Suspended"), "never resumed");
  });

  it("links a binding to its ClusterRole", async () => {
    await openResource("nav-item-rbac.authorization.k8s.io-rolebindings", "RoleBinding");
    await searchResources("admin-robot");
    await byTestId(rowId(NS, "admin-robot")).click();
    await byTestId("detail-drawer").$("button=ClusterRole view").click();
    // The ClusterRole opens in the drawer; the list stays the RoleBindings (spec H43).
    await until(
      async () =>
        (await byTestId("detail-kind").getText()) === "ClusterRole" &&
        (await byTestId("detail-title").getText()) === "view",
      "the drawer never showed the ClusterRole",
    );
    expect(await byTestId("resource-title").getText()).toBe("RoleBinding");
    await clickWhenShown("detail-close");
  });

  it("shows a namespace's quota summary", async () => {
    await openResource("nav-item-core-namespaces", "Namespace");
    await searchResources(NS);
    await $('[data-testid^="resource-row-"]').click();
    await until(async () => (await (await shown("detail-quota-summary")).getText()).includes("pods"), "no quota shown");
    await clickWhenShown("detail-close");
  });
});
