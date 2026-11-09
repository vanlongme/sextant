import { createTestNamespace, deleteTestNamespace, kubectl } from "../helpers/kube";
import {
  byTestId, clickWhenShown, closeDockTabs, openCluster, openResource, resourceRowMenu,
  rowId, searchResources, shown,
} from "../helpers/ui";

const KIND = "kind-skopos-e2e";
const NS = "skopos-test-logs";
const IMAGE = "registry.k8s.io/e2e-test-images/agnhost:2.53";
const until = (check: () => Promise<boolean>, timeoutMsg: string) =>
  browser.waitUntil(check, { timeout: 60000, interval: 500, timeoutMsg });

// String.raw keeps the backslashes for printf. Shell variables are written $name,
// never with braces, so the template does not take them.
const MANIFEST = String.raw`
apiVersion: v1
kind: Pod
metadata:
  name: printer
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
          echo "alpha one"
          printf '\033[31mred text\033[0m after\n'
          echo "ERROR something failed"
          echo "alpha two"
          i=0
          while true; do i=$((i + 1)); echo "tick $i"; sleep 1; done
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pair
  namespace: ${NS}
spec:
  replicas: 2
  selector:
    matchLabels: { app: pair }
  template:
    metadata:
      labels: { app: pair }
    spec:
      terminationGracePeriodSeconds: 0
      containers:
        - name: main
          image: ${IMAGE}
          env:
            - name: POD_NAME
              valueFrom:
                fieldRef: { fieldPath: metadata.name }
          command:
            - /bin/sh
            - -c
            - |
              while true; do echo "hello from $POD_NAME"; sleep 2; done
---
apiVersion: v1
kind: Pod
metadata:
  name: crasher
  namespace: ${NS}
spec:
  terminationGracePeriodSeconds: 0
  volumes:
    - name: state
      emptyDir: {}
  containers:
    - name: main
      image: ${IMAGE}
      volumeMounts:
        - { name: state, mountPath: /state }
      command:
        - /bin/sh
        - -c
        - |
          if [ -f /state/ran ]; then echo "second run"; exec sleep 3600; fi
          echo ran > /state/ran
          echo "first run"
          sleep 2
          exit 1
`;

/** The panel of the dock tab on screen. Hidden panels keep their content. */
const PANEL = '[data-testid="dock"] [role="tabpanel"]:not([hidden])';

/** An element of the Logs tab on screen. */
function logs(id: string) {
  return browser.$(`${PANEL} [data-testid="${id}"]`);
}

/** The text of the line rows that are drawn, top to bottom. */
async function logText(): Promise<string[]> {
  return browser.execute(
    (panel) =>
      Array.from(document.querySelectorAll(`${panel} [data-testid="log-line"]`)).map(
        (row) => row.textContent ?? "",
      ),
    PANEL,
  );
}

async function expectLog(part: string): Promise<void> {
  await until(
    async () => (await logText()).some((line) => line.includes(part)),
    `the log never showed "${part}"`,
  );
}

async function hits(): Promise<string> {
  return logs("logs-hits").getText();
}

async function status(): Promise<string> {
  return logs("logs-status").getText();
}

/** The highest "tick <n>" drawn, or 0. */
async function lastTick(): Promise<number> {
  const ticks = (await logText()).map((line) => Number(/tick (\d+)/.exec(line)?.[1] ?? 0));
  return Math.max(0, ...ticks);
}

/** The text of the row that holds the current search match. */
async function currentMarkLine(): Promise<string> {
  return browser.execute(
    (panel) =>
      document
        .querySelector(`${panel} [data-mark="current"]`)
        ?.closest('[data-testid="log-line"]')?.textContent ?? "",
    PANEL,
  );
}

async function scrollLogToTop(): Promise<void> {
  await browser.execute((panel) => {
    const view = document.querySelector(`${panel} [data-testid="logs-view"]`);
    if (view) view.scrollTop = 0;
  }, PANEL);
}

async function count(id: string): Promise<number> {
  return browser.execute(
    (panel, testId) => document.querySelectorAll(`${panel} [data-testid="${testId}"]`).length,
    PANEL,
    id,
  );
}

/** The inline color of the drawn text span that reads exactly `text`. */
async function colorOf(text: string): Promise<string | null> {
  return browser.execute(
    (panel, wanted) => {
      const spans = Array.from(
        document.querySelectorAll<HTMLElement>(`${panel} [data-testid="log-line"] span`),
      );
      const span = spans.find((s) => s.children.length === 0 && s.textContent === wanted);
      return span ? span.style.color : null;
    },
    PANEL,
    text,
  );
}

/** Each drawn "hello from <pod>" row: its prefix and the Pod it names. */
async function podLines(): Promise<{ prefix: string | null; pod: string }[]> {
  return browser.execute((panel) => {
    const rows = Array.from(document.querySelectorAll(`${panel} [data-testid="log-line"]`));
    const lines: { prefix: string | null; pod: string }[] = [];
    for (const row of rows) {
      const pod = /hello from (\S+)/.exec(row.textContent ?? "")?.[1];
      if (!pod) continue;
      const prefix = row.querySelector('[data-testid="log-prefix"]')?.textContent ?? null;
      lines.push({ prefix, pod });
    }
    return lines;
  }, PANEL);
}

async function containerState(pod: string): Promise<{ restarts: number; ready: boolean }> {
  const out = await kubectl([
    "-n", NS, "get", "pod", pod, "-o",
    "jsonpath={.status.containerStatuses[0].restartCount} {.status.containerStatuses[0].ready}",
  ]);
  const [restarts, ready] = out.trim().split(" ");
  return { restarts: Number(restarts || 0), ready: ready === "true" };
}

async function openDrawer(nav: string, kind: string, name: string): Promise<void> {
  await openResource(nav, kind);
  await searchResources(name);
  await byTestId(rowId(NS, name)).click();
  await shown("detail-drawer");
  await until(async () => (await byTestId("detail-title").getText()) === name, `the drawer never showed ${name}`);
}

describe("the Logs tab on the kind cluster", () => {
  before(async function () {
    // Image pulls, a rollout and one container restart.
    this.timeout(300000);
    await createTestNamespace(NS);
    await kubectl(["apply", "-f", "-"], MANIFEST);
    await kubectl(["-n", NS, "wait", "--for=condition=Ready", "pod/printer", "--timeout=180s"]);
    await kubectl(["-n", NS, "rollout", "status", "deployment/pair", "--timeout=180s"]);
    await browser.waitUntil(
      async () => {
        const state = await containerState("crasher");
        return state.restarts >= 1 && state.ready;
      },
      { timeout: 180000, interval: 1000, timeoutMsg: "crasher never restarted" },
    );
    await openCluster(KIND);
  });

  after(async () => {
    await deleteTestNamespace(NS);
  });

  it("opens Logs from the drawer header and shows the lines with their colors", async () => {
    await openDrawer("nav-item-core-pods", "Pod", "printer");
    await clickWhenShown("detail-action-logs");
    await shown("logs-tab");
    await expectLog("tick");
    await until(async () => (await status()) === "Following", "the tab never followed");

    await scrollLogToTop();
    await expectLog("alpha one");
    expect(await colorOf("ERROR")).toBe("var(--text-danger)");
    expect(await colorOf("red text")).toBe("var(--text-danger)");
  });

  it("hides and shows the timestamps", async () => {
    expect(await count("log-time")).toBeGreaterThan(0);
    await logs("logs-timestamps").click();
    await until(async () => (await count("log-time")) === 0, "the timestamps stayed");
    await logs("logs-timestamps").click();
    await until(async () => (await count("log-time")) > 0, "the timestamps never came back");
  });

  it("searches, and steps through the matches with the arrows, Enter and Shift+Enter", async () => {
    await logs("logs-search").setValue("alpha");
    await until(async () => (await hits()) === "1 of 2", "the search never found two matches");

    await logs("logs-next-match").click();
    await until(async () => (await hits()) === "2 of 2", "Next match never moved");
    await until(async () => (await currentMarkLine()).includes("alpha two"), "the current match is not on alpha two");
    await logs("logs-prev-match").click();
    await until(async () => (await hits()) === "1 of 2", "Previous match never moved");
    await until(async () => (await currentMarkLine()).includes("alpha one"), "the current match is not on alpha one");

    await logs("logs-search").click();
    await browser.keys("Enter");
    await until(async () => (await hits()) === "2 of 2", "Enter never moved to the next match");
    await browser.keys(["Shift", "Enter"]);
    await until(async () => (await hits()) === "1 of 2", "Shift+Enter never moved back");
  });

  it("follows new lines, pauses with Follow off and follows again with it on", async () => {
    await logs("logs-search").click();
    await browser.keys(["Control", "a"]);
    await browser.keys("Backspace");
    await until(async () => (await hits()).endsWith(" lines"), "the search never cleared");
    // The jumps paused autoscroll; End resumes it.
    await logs("logs-view").click();
    await browser.keys("End");
    const first = await lastTick();
    await until(async () => (await lastTick()) > first, "no new line arrived");

    await logs("logs-follow").click();
    await until(async () => (await status()) === "Paused", "Follow off never paused");
    const paused = await hits();
    await browser.pause(3000);
    expect(await hits()).toBe(paused);
    expect(await status()).toBe("Paused");

    await logs("logs-follow").click();
    await until(async () => (await status()) === "Following", "Follow on never followed");
    const resumed = await lastTick();
    await until(async () => (await lastTick()) > resumed, "no line arrived after Follow on");
  });

  it("shows the lines of both Pods of a Deployment, each with its Pod's suffix", async () => {
    await closeDockTabs();
    await openResource("nav-item-apps-deployments", "Deployment");
    await searchResources("pair");
    await resourceRowMenu("pair", "logs");
    await shown("logs-tab");
    const names = (
      await kubectl(["-n", NS, "get", "pods", "-l", "app=pair", "-o", "jsonpath={.items[*].metadata.name}"])
    ).trim().split(" ").sort();

    let seen: string[] = [];
    await until(async () => {
      const lines = await podLines();
      seen = [...new Set(lines.map((l) => l.pod))].sort();
      return (
        JSON.stringify(seen) === JSON.stringify(names) &&
        lines.every((l) => l.prefix === l.pod.slice(l.pod.lastIndexOf("-") + 1))
      );
    }, `the tab never showed both Pods with their prefixes; it showed ${seen.join(", ")}`);
  });

  it("reads the previous instance of a restarted container", async () => {
    await closeDockTabs();
    await openDrawer("nav-item-core-pods", "Pod", "crasher");
    await clickWhenShown("detail-action-logs");
    await expectLog("second run");

    const previous = logs("logs-previous");
    await until(async () => (await previous.getAttribute("data-disabled")) === null, "Previous stayed disabled");
    await previous.click();
    await until(async () => (await status()) === "Previous instance", "the tab never read the previous instance");
    await expectLog("first run");
    expect((await logText()).some((line) => line.includes("second run"))).toBe(false);
  });
});
