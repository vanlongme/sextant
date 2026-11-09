import { createTestNamespace, deleteTestNamespace, kubectl } from "../helpers/kube";
import {
  byTestId, clickWhenShown, closeDockTabs, dialogButton, dockTabTitles, expectTerminalLine,
  expectTerminalStatus, gone, inDockPanel, openCluster, openResource, pointerClick,
  requestNodeShell, resourceRowMenu, rowId, searchResources, shown, terminalRows, typeInTerminal,
} from "../helpers/ui";

const KIND = "kind-skopos-e2e";
const NS = "skopos-test-terminal";
const WORKER = "skopos-e2e-worker";
const IMAGE = "registry.k8s.io/e2e-test-images/agnhost:2.53";
const NODE_SHELL_PODS = [
  "-n", "kube-system", "get", "pods", "-l", "skopos.dev/node-shell=true", "-o", "name",
];
const until = (check: () => Promise<boolean>, timeoutMsg: string, timeout = 60000) =>
  browser.waitUntil(check, { timeout, interval: 500, timeoutMsg });

// String.raw keeps the shell's $ signs. Shell variables are written $name, never
// with braces, so the template does not take them.
const MANIFEST = String.raw`
apiVersion: v1
kind: Pod
metadata:
  name: duo
  namespace: ${NS}
spec:
  terminationGracePeriodSeconds: 0
  containers:
    - name: first
      image: ${IMAGE}
      command: ["/bin/sh", "-c", "sleep 100000"]
      env:
        - { name: WHICH, value: first }
    - name: second
      image: ${IMAGE}
      command: ["/bin/sh", "-c", "sleep 100000"]
      env:
        - { name: WHICH, value: second }
---
apiVersion: v1
kind: Pod
metadata:
  name: counter
  namespace: ${NS}
spec:
  terminationGracePeriodSeconds: 0
  containers:
    - name: main
      image: ${IMAGE}
      command:
        - /bin/sh
        - -c
        - |
          i=0
          while true; do i=$((i + 1)); echo "count $i"; sleep 1; done
`;

async function expectTab(title: string): Promise<void> {
  await until(async () => (await dockTabTitles()).includes(title), `the dock never showed ${title}`);
}

async function nodeShellPods(): Promise<string> {
  return (await kubectl(NODE_SHELL_PODS)).trim();
}

async function openDrawer(name: string): Promise<void> {
  await openResource("nav-item-core-pods", "Pod");
  await searchResources(name);
  await byTestId(rowId(NS, name)).click();
  await shown("detail-drawer");
  await until(async () => (await byTestId("detail-title").getText()) === name, `the drawer never showed ${name}`);
}

describe("terminal tabs on the kind cluster", () => {
  before(async function () {
    this.timeout(300000);
    await createTestNamespace(NS);
    await kubectl(["apply", "-f", "-"], MANIFEST);
    await kubectl(["-n", NS, "wait", "--for=condition=Ready", "pod/duo", "pod/counter", "--timeout=180s"]);
    await openCluster(KIND);
  });

  after(async () => {
    await closeDockTabs();
    await kubectl([
      "-n", "kube-system", "delete", "pod", "-l", "skopos.dev/node-shell=true", "--ignore-not-found",
    ]);
    await deleteTestNamespace(NS);
  });

  it("opens the local terminal from the dock bar, and the shell answers", async () => {
    await clickWhenShown("dock-terminal");
    await expectTab(`Terminal · ${KIND}`);
    await expectTerminalStatus("Local shell");
    expect(await inDockPanel("terminal-tab").getText()).toContain(
      "kubectl and helm in this tab use this cluster's context.",
    );
    await typeInTerminal("echo skopos-$((6*7))");
    await expectTerminalLine("skopos-42");
  });

  it("keeps the output and the shell across a trip to the catalog", async () => {
    await clickWhenShown("nav-catalog");
    await gone("dock");
    await openCluster(KIND);
    await expectTerminalLine("skopos-42");
    await typeInTerminal("echo back-$((1+1))");
    await expectTerminalLine("back-2");
  });

  it("stays responsive through a flood of output", async function () {
    this.timeout(300000);
    await typeInTerminal("yes skopos-flood | head -n 200000; echo flood-$((5*5))");
    await expectTerminalLine("flood-25", 180000);
    await typeInTerminal("echo after-flood-$((2*4))");
    await expectTerminalLine("after-flood-8");
  });

  it("opens Shell on a Pod in its first running container", async () => {
    await openDrawer("duo");
    await clickWhenShown("detail-action-shell");
    await expectTab("Shell · duo");
    // The drawer would cover part of the dock's toolbar.
    await clickWhenShown("detail-close");
    await gone("detail-drawer");
    await expectTerminalStatus("Connected");
    await typeInTerminal("echo host-$(cat /etc/hostname)");
    await expectTerminalLine("host-duo");
    await typeInTerminal("echo container-$WHICH");
    await expectTerminalLine("container-first");
  });

  it("starts a new session when the container changes", async () => {
    await pointerClick(await inDockPanel("shell-container"));
    const second = browser.$('//*[@role="option"][normalize-space()="second"]');
    await second.waitForDisplayed({ timeout: 15000 });
    await pointerClick(await second);
    await until(
      async () => !(await terminalRows()).some((row) => row.trim() === "container-first"),
      "the screen was never cleared for the new session",
    );
    await expectTerminalStatus("Connected");
    await typeInTerminal("echo container-$WHICH");
    await expectTerminalLine("container-second");
  });

  it("attaches to a Pod's process, shows its output and says input is off", async () => {
    await openResource("nav-item-core-pods", "Pod");
    await searchResources("counter");
    await resourceRowMenu("counter", "attach");
    await expectTab("Attach · counter");
    await expectTerminalStatus("Attached");
    expect(await inDockPanel("attach-note").getText()).toContain(
      "so input is off and only its output shows.",
    );
    await until(
      async () => (await terminalRows()).some((row) => /^count \d+$/.test(row.trim())),
      "the attach never showed the counter",
    );
    expect(await inDockPanel("terminal-reconnect").isExisting()).toBe(false);

    await inDockPanel("attach-detach").click();
    await until(
      async () => !(await dockTabTitles()).includes("Attach · counter"),
      "Detach never closed the tab",
    );
  });

  it("asks before a node shell, runs it on the node, and deletes its Pod with the tab", async function () {
    this.timeout(420000);
    await requestNodeShell(WORKER);
    const dialog = browser.$('[role="dialog"]');
    expect(await dialog.getText()).toContain(`Open a root shell on ${WORKER}?`);
    expect(await dialog.getText()).toContain("(image alpine:3.22, host PID namespace)");
    await dialogButton("Open shell").click();

    await expectTab(`Shell · ${WORKER}`);
    await expectTerminalStatus("Connected", 240000);
    await typeInTerminal("echo host-$(cat /etc/hostname)");
    await expectTerminalLine(`host-${WORKER}`);
    expect(await nodeShellPods()).not.toBe("");

    await browser.$('[data-testid^="dock-close-node-shell:"]').click();
    await until(async () => (await nodeShellPods()) === "", "the node shell Pod was never deleted", 120000);
  });
});
