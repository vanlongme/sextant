import fs from "node:fs";
import path from "node:path";
import {
  createTestNamespace,
  deleteTestNamespace,
  kubectl,
} from "../helpers/kube";
import {
  byTestId,
  clickWhenShown,
  gone,
  openCluster,
  openResource,
  pointerClick,
  resourceRowMenu,
  rowId,
  shown,
} from "../helpers/ui";

const home = process.env.SKOPOS_E2E_HOME as string;
const NS = "skopos-test-e2e";
const CONTEXT = "viewer";
const POD = "victim";
const VIEWER_USER = `system:serviceaccount:${NS}:viewer`;

function viewerObjects(verbs: string[]): string {
  return `
apiVersion: v1
kind: ServiceAccount
metadata:
  name: viewer
  namespace: ${NS}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: viewer-pods
  namespace: ${NS}
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ${JSON.stringify(verbs)}
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: viewer-pods
  namespace: ${NS}
subjects:
  - kind: ServiceAccount
    name: viewer
    namespace: ${NS}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: viewer-pods
`;
}

/** A kubeconfig of the kind cluster that signs in as the service account. */
async function viewerKubeconfig(): Promise<string> {
  const token = await kubectl([
    "-n",
    NS,
    "create",
    "token",
    "viewer",
    "--duration=1h",
  ]);
  const admin = JSON.parse(
    await kubectl(["config", "view", "--raw", "--minify", "-o", "json"]),
  );
  return JSON.stringify({
    apiVersion: "v1",
    kind: "Config",
    clusters: [{ name: CONTEXT, cluster: admin.clusters[0].cluster }],
    users: [{ name: CONTEXT, user: { token: token.trim() } }],
    contexts: [
      {
        name: CONTEXT,
        context: { cluster: CONTEXT, user: CONTEXT, namespace: NS },
      },
    ],
    "current-context": CONTEXT,
  });
}

/** Whether the API server would let the viewer delete pods, which `auth can-i` ends non-zero to deny. */
async function viewerMayDeletePods(): Promise<boolean> {
  return kubectl([
    "auth",
    "can-i",
    "delete",
    "pods",
    "-n",
    NS,
    "--as",
    VIEWER_USER,
  ]).then(
    () => true,
    () => false,
  );
}

describe("a user limited by RBAC", () => {
  before(async () => {
    await createTestNamespace(NS);
    await kubectl(
      ["apply", "-f", "-"],
      viewerObjects(["get", "list", "watch", "delete"]),
    );
    await kubectl([
      "-n",
      NS,
      "run",
      POD,
      "--image=registry.k8s.io/pause:3.10",
      "--restart=Never",
    ]);
    fs.writeFileSync(
      path.join(home, ".kube", CONTEXT),
      await viewerKubeconfig(),
    );
  });

  after(async () => {
    await deleteTestNamespace(NS);
  });

  it("connects and warns about namespaces", async () => {
    await openCluster(CONTEXT);
    const warning = await shown("cluster-namespaces-warning");
    expect(await warning.getText()).toContain(NS);
    expect(await byTestId("cluster-info-namespaces").getText()).toBe(
      "Restricted",
    );
  });

  it("shows Pods and hides Nodes and Secrets", async () => {
    await shown("nav-item-core-pods");
    expect(await byTestId("nav-item-core-nodes").isExisting()).toBe(false);
    expect(await byTestId("nav-item-core-secrets").isExisting()).toBe(false);
  });

  it("lists the pods of the namespace", async () => {
    await openResource("nav-item-core-pods", "Pod");
    await shown(rowId(NS, POD));
  });

  it("shows the API's forbidden message in a toast when a delete fails", async () => {
    // The app hides what the access checks at connect time deny, so a delete it
    // still offers can only be refused if the right is taken away afterwards.
    await kubectl(
      ["apply", "-f", "-"],
      viewerObjects(["get", "list", "watch"]),
    );
    await browser.waitUntil(async () => !(await viewerMayDeletePods()), {
      timeout: 15000,
      interval: 200,
      timeoutMsg: "the API server kept allowing the delete",
    });

    await resourceRowMenu(POD, "delete");
    await clickWhenShown("delete-confirm");
    await gone("delete-confirm");

    const toast = await shown("toast");
    await browser.waitUntil(
      async () => (await toast.getText()).includes("forbidden"),
      {
        timeoutMsg: "the toast never quoted the API's message",
      },
    );
    expect(await toast.getText()).toContain(VIEWER_USER);

    await shown(rowId(NS, POD));
    const stillThere = await kubectl([
      "-n",
      NS,
      "get",
      "pod",
      POD,
      "-o",
      "name",
    ]);
    expect(stillThere.trim()).toBe(`pod/${POD}`);
  });

  it("a forbidden scale shows the API's message", async () => {
    await kubectl(
      ["-n", NS, "create", "deployment", "web", "--image=registry.k8s.io/pause:3.10"],
    );
    await openResource("nav-item-apps-deployments", "Deployment");
    await shown(rowId(NS, "web"));
    await resourceRowMenu("web", "scale");
    await (await shown("scale-replicas")).setValue("2");
    await clickWhenShown("scale-confirm");
    const alert = await $('//*[@role="dialog"]//*[@role="alert"]');
    await alert.waitForDisplayed({ timeout: 15000 });
    await browser.waitUntil(async () => (await alert.getText()).includes("forbidden"), {
      timeoutMsg: "the dialog never quoted the API's message",
    });
    await browser.keys("Escape");
  });

  it("a patch-gated action is disabled for a user who may not patch", async () => {
    await pointerClick(await shown("row-menu-web"));
    const item = await shown("menu-item-restart");
    expect(await item.getAttribute("aria-disabled")).toBe("true");
    await browser.keys("Escape");
  });
});
