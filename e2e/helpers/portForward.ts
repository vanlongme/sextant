import net from "node:net";
import { createTestNamespace, kubectl } from "./kube";
import {
  byTestId,
  clickWhenShown,
  gone,
  openResource,
  pointerClick,
  rowId,
  searchResources,
  shown,
} from "./ui";

const TIMEOUT = 15000;

/** The echo server of spec §9: a Deployment and a Service, both named echo. */
export function echoManifest(namespace: string): string {
  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: echo
  namespace: ${namespace}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: echo
  template:
    metadata:
      labels:
        app: echo
    spec:
      containers:
        - name: echo
          image: registry.k8s.io/e2e-test-images/agnhost:2.53
          args: ["netexec", "--http-port=8080"]
          ports:
            - name: http
              containerPort: 8080
          readinessProbe:
            httpGet:
              path: /hostname
              port: http
            periodSeconds: 1
---
apiVersion: v1
kind: Service
metadata:
  name: echo
  namespace: ${namespace}
spec:
  selector:
    app: echo
  ports:
    - name: http
      port: 80
      targetPort: http
`;
}

/** The name of the echo Pod that runs. */
export async function echoPod(namespace: string): Promise<string> {
  return (
    await kubectl([
      "-n",
      namespace,
      "get",
      "pods",
      "-l",
      "app=echo",
      "--field-selector=status.phase=Running",
      "-o",
      "jsonpath={.items[0].metadata.name}",
    ])
  ).trim();
}

/** Creates the namespace and the echo server, waits until it is Ready, and gives the Pod's name. */
export async function deployEcho(namespace: string): Promise<string> {
  await createTestNamespace(namespace);
  await kubectl(["apply", "-f", "-"], echoManifest(namespace));
  await kubectl([
    "-n",
    namespace,
    "rollout",
    "status",
    "deployment/echo",
    "--timeout=180s",
  ]);
  return echoPod(namespace);
}

/** Listens on a free port of 127.0.0.1 until `close`. */
export function holdPort(): Promise<{ port: number; close(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("the test server has no port"));
        return;
      }
      resolve({
        port: address.port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

/** A port of 127.0.0.1 that was free a moment ago. */
export async function freePort(): Promise<number> {
  const held = await holdPort();
  await held.close();
  return held.port;
}

/** Sends `count` requests at once to /hostname on the local port. */
export function hostnames(
  port: number,
  count: number,
): Promise<{ status: number; body: string }[]> {
  return Promise.all(
    Array.from({ length: count }, async () => {
      const response = await fetch(`http://127.0.0.1:${port}/hostname`);
      return { status: response.status, body: (await response.text()).trim() };
    }),
  );
}

/** Waits until `count` parallel requests all answer 200 with the Pod's name. */
export async function expectAnswers(
  port: number,
  pod: string,
  count = 1,
): Promise<void> {
  let last = "";
  await browser
    .waitUntil(
      async () => {
        try {
          const answers = await hostnames(port, count);
          last = JSON.stringify(answers);
          return answers.every((a) => a.status === 200 && a.body === pod);
        } catch (error) {
          last = String(error);
          return false;
        }
      },
      { timeout: 30000, interval: 500 },
    )
    .catch(() => {
      throw new Error(
        `127.0.0.1:${port} never answered ${count} times with ${pod}; last: ${last}`,
      );
    });
}

export async function openPortForwards(): Promise<void> {
  await clickWhenShown("nav-port-forwards");
  await shown("port-forwards-screen");
}

/** Opens the echo Service's drawer and its Forward button on port 80. */
export async function openForwardDialogOnService(
  namespace: string,
): Promise<void> {
  await openResource("nav-item-core-services", "Service");
  await searchResources("echo");
  await (await shown(rowId(namespace, "echo"))).click();
  await clickWhenShown("service-port-forward-80");
  await shown("pf-dialog");
}

/**
 * Fills the local port (null for a random one), unticks the browser box,
 * because no real browser may open under the driver, and presses Start.
 */
export async function startInDialog(localPort: number | null): Promise<void> {
  await (await shown("pf-local-port")).setValue(
    localPort === null ? "" : String(localPort),
  );
  const box = byTestId("pf-open-browser");
  if (await box.isSelected()) await box.click();
  await clickWhenShown("pf-start");
}

/** The ids of the forward rows on screen, top to bottom. */
export function forwardRowIds(): Promise<string[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll('[data-testid^="pf-row-"]')).map(
      (row) => (row.getAttribute("data-testid") ?? "").slice("pf-row-".length),
    ),
  );
}

/** The ids of the rows whose Name, Namespace and Kind cells match. */
export function forwardIds(
  kind: "Pod" | "Service",
  name: string,
  namespace: string,
): Promise<string[]> {
  return browser.execute(
    (k, n, ns) =>
      Array.from(document.querySelectorAll('[data-testid^="pf-row-"]'))
        .filter((row) => {
          // The first cell holds the row's checkbox.
          const cells = Array.from(row.querySelectorAll("td")).map((td) =>
            (td.textContent ?? "").trim(),
          );
          return cells[1] === n && cells[2] === ns && cells[3] === k;
        })
        .map((row) =>
          (row.getAttribute("data-testid") ?? "").slice("pf-row-".length),
        ),
    kind,
    name,
    namespace,
  );
}

export async function waitForwardId(
  kind: "Pod" | "Service",
  name: string,
  namespace: string,
): Promise<string> {
  let ids: string[] = [];
  await browser.waitUntil(
    async () => {
      ids = await forwardIds(kind, name, namespace);
      return ids.length > 0;
    },
    {
      timeout: TIMEOUT,
      timeoutMsg: `no port forward row for ${kind} ${namespace}/${name}`,
    },
  );
  return ids[0] ?? "";
}

export async function expectForwardStatus(
  id: string,
  label: string,
  timeout = 30000,
): Promise<void> {
  let last = "";
  await browser
    .waitUntil(
      async () => {
        const status = byTestId(`pf-status-${id}`);
        last = (await status.isExisting()) ? await status.getText() : "(no row)";
        return last === label;
      },
      { timeout, interval: 300 },
    )
    .catch(() => {
      throw new Error(`the forward ${id} never read ${label}; it reads ${last}`);
    });
}

/** The bound port in the row's Local cell. */
export async function boundPort(id: string): Promise<number> {
  const text = (await byTestId(`pf-local-${id}`).getText()).trim();
  const match = /^127\.0\.0\.1:(\d+)$/.exec(text);
  if (!match) throw new Error(`the forward ${id} has no bound port: ${text}`);
  return Number(match[1]);
}

/** Waits until the forward's current address answers with the Pod's name; gives the port. */
export async function expectForwardAnswers(
  id: string,
  pod: string,
  count = 1,
): Promise<number> {
  let last = "";
  let port = 0;
  await browser
    .waitUntil(
      async () => {
        try {
          port = await boundPort(id);
          const answers = await hostnames(port, count);
          last = JSON.stringify(answers);
          return answers.every((a) => a.status === 200 && a.body === pod);
        } catch (error) {
          last = String(error);
          return false;
        }
      },
      { timeout: 30000, interval: 500 },
    )
    .catch(() => {
      throw new Error(`the forward ${id} never answered with ${pod}; last: ${last}`);
    });
  return port;
}

/** Picks an item from a forward row's menu. */
export async function forwardMenu(id: string, item: string): Promise<void> {
  await pointerClick(await shown(`pf-menu-${id}`));
  await clickWhenShown(`pf-${item}-${id}`);
  await gone(`pf-${item}-${id}`);
}
