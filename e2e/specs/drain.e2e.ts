import { createTestNamespace, deleteTestNamespace, kubectl } from "../helpers/kube";
import {
  byTestId, clickWhenShown, openCluster, openResource, resourceRowMenu, rowId,
  searchResources, shown,
} from "../helpers/ui";

const KIND = "kind-sextant-e2e";
const WORKER = "sextant-e2e-worker";
const NS = "sextant-test-drain-e2e";
const until = (check: () => Promise<boolean>, timeoutMsg: string) =>
  browser.waitUntil(check, { timeout: 120000, interval: 500, timeoutMsg });

const MANIFEST = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: movable
  namespace: ${NS}
spec:
  replicas: 1
  selector:
    matchLabels: { app: movable }
  template:
    metadata:
      labels: { app: movable }
    spec:
      terminationGracePeriodSeconds: 0
      containers:
        - name: main
          image: registry.k8s.io/pause:3.10
---
apiVersion: v1
kind: Pod
metadata:
  name: lonely
  namespace: ${NS}
spec:
  nodeName: ${WORKER}
  terminationGracePeriodSeconds: 0
  containers:
    - name: main
      image: registry.k8s.io/pause:3.10
`;

const BUDGET = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: guarded
  namespace: ${NS}
spec:
  replicas: 1
  selector:
    matchLabels: { app: guarded }
  template:
    metadata:
      labels: { app: guarded }
    spec:
      terminationGracePeriodSeconds: 0
      nodeSelector:
        kubernetes.io/hostname: ${WORKER}
      containers:
        - name: main
          image: registry.k8s.io/pause:3.10
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: guarded
  namespace: ${NS}
spec:
  minAvailable: 1
  selector:
    matchLabels: { app: guarded }
`;

async function unschedulable(): Promise<string> {
  return (await kubectl(["get", "node", WORKER, "-o", "jsonpath={.spec.unschedulable}"])).trim();
}

async function openNodeMenu(item: string) {
  await openResource("nav-item-core-nodes", "Node");
  await searchResources(WORKER);
  await resourceRowMenu(WORKER, item);
}

async function closeDrain() {
  await clickWhenShown("drain-close");
}

describe("cordon and drain on a real node", () => {
  before(async () => {
    await deleteTestNamespace(NS);
    await createTestNamespace(NS);
    await kubectl(["apply", "-f", "-"], MANIFEST);
    await kubectl(["-n", NS, "wait", "--for=condition=Ready", "pod/lonely", "--timeout=120s"]);
    await openCluster(KIND);
  });

  after(async () => {
    await kubectl(["uncordon", WORKER]);
    await deleteTestNamespace(NS);
  });

  it("cordons and uncordons", async () => {
    await openNodeMenu("cordon");
    await until(async () => (await byTestId(`resource-row-${WORKER}`).getText()).includes("SchedulingDisabled"), "never cordoned");
    expect(await unschedulable()).toBe("true");
    await resourceRowMenu(WORKER, "uncordon");
    await until(async () => !(await byTestId(`resource-row-${WORKER}`).getText()).includes("SchedulingDisabled"), "never uncordoned");
    expect(await unschedulable()).toBe("");
  });

  it("refuses a drain with an unmanaged pod and says the node stays cordoned", async () => {
    await openNodeMenu("drain");
    await clickWhenShown("drain-start");
    await until(async () => (await (await shown("drain-outcome")).getText()).includes(`${NS}/lonely`), "the outcome never named the pod");
    await shown("drain-still-cordoned");
    await closeDrain();
    await resourceRowMenu(WORKER, "uncordon");
    await until(async () => (await unschedulable()) === "", "never uncordoned");
  });

  it("drains with force and shows progress", async () => {
    await openNodeMenu("drain");
    await clickWhenShown("drain-force");
    await clickWhenShown("drain-start");
    await until(async () => /drained/i.test(await (await shown("drain-outcome")).getText()), "the drain never completed");
    const pods = JSON.parse(await kubectl(["get", "pods", "-A", "--field-selector", `spec.nodeName=${WORKER}`, "-o", "json"]));
    const owners = (pod: any) => (pod.metadata.ownerReferences ?? []).map((o: any) => o.kind);
    const remaining = pods.items.filter((p: any) => !owners(p).includes("DaemonSet"));
    expect(remaining.map((p: any) => p.metadata.name)).toEqual([]);
    expect(pods.items.some((p: any) => owners(p).includes("DaemonSet"))).toBe(true);
    await closeDrain();
    await resourceRowMenu(WORKER, "uncordon");
    await until(async () => (await unschedulable()) === "", "never uncordoned");
  });

  it("can cancel a drain blocked by a disruption budget", async () => {
    await kubectl(["apply", "-f", "-"], BUDGET);
    await kubectl(["-n", NS, "rollout", "status", "deployment/guarded", "--timeout=120s"]);
    const pod = (await kubectl(["-n", NS, "get", "pods", "-l", "app=guarded", "-o", "jsonpath={.items[0].metadata.name}"])).trim();
    await openNodeMenu("drain");
    await clickWhenShown("drain-start");
    await until(async () => (await (await shown(`drain-pod-${NS}-${pod}`)).getText()).includes("disruption budget"), "the blocked pod never showed the budget");
    await clickWhenShown("drain-cancel");
    await until(async () => /cancel/i.test(await (await shown("drain-outcome")).getText()), "the drain never reported cancelling");
    await closeDrain();
    await resourceRowMenu(WORKER, "uncordon");
    await until(async () => (await unschedulable()) === "", "never uncordoned");
  });
});
