import { replaceText } from "../helpers/helm";
import { kubectl } from "../helpers/kube";
import {
  ensureMetricsProviders,
  PROMETHEUS_SERVER_SELECTOR,
  type PrometheusService,
} from "../helpers/metrics";
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
} from "../helpers/ui";

const KIND = "kind-skopos-e2e";
const PODS = "nav-item-core-pods";
/** Prometheus scrapes every 15 s, and a rate needs two scrapes inside its window. */
const SAMPLES_TIMEOUT = 5 * 60_000;
/** metrics-server is read every 15 s; its own scrape adds up to a minute on a new install. */
const USAGE_TIMEOUT = 45_000;
const SAVED = "Saved. Changes apply at once; the proxy applies on the next connect.";

let prometheus: PrometheusService = { namespace: "", service: "", port: 0 };

async function text(id: string): Promise<string> {
  const element = byTestId(id);
  if (!(await element.isExisting())) return "";
  return (await element.getText()).trim();
}

async function until(
  check: () => Promise<boolean>,
  message: string,
  timeout = 60_000,
): Promise<void> {
  await browser.waitUntil(check, { timeout, interval: 1000, timeoutMsg: message });
}

/**
 * The texts of every cell with this test id in the Pods table's rows. An open drawer's
 * summary renders the same cells, so only cells inside a table row count.
 */
async function usageCells(id: "usage-cpu" | "usage-memory"): Promise<string[]> {
  return browser.execute(
    (testId: string) =>
      Array.from(
        document.querySelectorAll(
          `[data-testid^="resource-row-"] [data-testid="${testId}"]`,
        ),
      ).map((cell) => (cell.textContent ?? "").trim()),
    id,
  );
}

/** True when every chart's "now" value is a number rather than "—". */
async function chartsHaveData(stems: string[]): Promise<boolean> {
  for (const stem of stems) {
    const now = await text(`metrics-chart-${stem}-now`);
    if (now === "" || now === "—") return false;
  }
  return true;
}

/** Opens the cluster's Settings page from the header, picks a provider and saves. */
async function saveProvider(
  kind: "auto" | "prometheus" | "metricsServer" | "none",
): Promise<void> {
  await clickWhenShown("header-cluster-settings");
  await shown("cluster-settings", 30_000);
  await shown("settings-save", 30_000);
  await clickWhenShown(`settings-metrics-${kind}`);
  if (kind === "prometheus") {
    await replaceText("settings-prom-namespace", prometheus.namespace);
    await replaceText("settings-prom-service", prometheus.service);
    await replaceText("settings-prom-port", String(prometheus.port));
  }
  const save = byTestId("settings-save");
  await save.waitForEnabled({ timeout: 15_000 });
  await save.click();
  await until(
    async () => (await text("settings-status")) === SAVED,
    `the ${kind} setting was never saved`,
  );
}

async function openOverview(): Promise<void> {
  await clickWhenShown("nav-overview");
  await shown("overview-metrics", 30_000);
}

describe("metrics", () => {
  before(async function () {
    // A new kind cluster pulls metrics-server and the Prometheus chart's images.
    this.timeout(900_000);
    prometheus = await ensureMetricsProviders();
    await openCluster(KIND);
  });

  it("None turns metrics off: the Overview says so and the Pods table shows dashes", async () => {
    await saveProvider("none");
    await openOverview();
    await until(
      async () =>
        (await text("metrics-note")).startsWith(
          "Metrics are off: the metrics provider is None in the cluster settings.",
        ),
      "the Overview never said that metrics are off",
    );
    expect(await byTestId("overview-gauges").isExisting()).toBe(false);

    await openResource(PODS, "Pod");
    await until(
      async () => (await usageCells("usage-cpu")).length > 0,
      "the Pods table never showed its CPU cells",
    );
    expect((await usageCells("usage-cpu")).every((cell) => cell === "—")).toBe(true);
  });

  it("a pinned Prometheus fills the gauges and charts, reads 6h, shows a table and moves the readout", async function () {
    this.timeout(SAMPLES_TIMEOUT + 6 * 60_000);
    await saveProvider("prometheus");
    await openOverview();
    await until(
      async () =>
        (await text("metrics-source")) ===
        `Prometheus ${prometheus.namespace}/${prometheus.service}:${prometheus.port}, pinned in the cluster settings, through the API server proxy`,
      "the source line never named the pinned Prometheus",
    );
    await until(
      () => chartsHaveData(["cpu", "memory", "pods", "disk"]),
      "the CPU, Memory, Pods and Disk charts never showed data",
      SAMPLES_TIMEOUT,
    );
    await until(
      async () =>
        /^\d+(\.\d)? of \d+(\.\d)? cores · Prometheus$/.test(
          await text("overview-gauge-cpu-caption"),
        ) &&
        /^\d+(\.\d)? of \d+(\.\d)? GiB · Prometheus$/.test(
          await text("overview-gauge-memory-caption"),
        ),
      "the gauges never showed numbers",
    );
    expect(await byTestId("overview-gauge-cpu").getAttribute("aria-valuenow")).toMatch(
      /^\d+$/,
    );

    await clickWhenShown("metrics-range-6h");
    await until(
      async () =>
        (
          (await byTestId("metrics-chart-cpu-plot").getAttribute("aria-label")) ?? ""
        ).startsWith("CPU over the last 6 hours: Usage now "),
      "the CPU chart never showed the last 6 hours",
      120_000,
    );

    await clickWhenShown("metrics-view-table");
    const table = await shown("metrics-table-cpu");
    await until(
      async () => (await table.$$("tbody tr").length) > 0,
      "the CPU table never showed a row",
    );

    await clickWhenShown("metrics-view-chart");
    await clickWhenShown("metrics-range-1h");
    await shown("metrics-chart-cpu-plot");
    await until(
      async () => {
        await browser.execute(() => {
          const plot = document.querySelector<HTMLElement>(
            '[data-testid="metrics-chart-cpu-plot"]',
          );
          plot?.focus();
        });
        await browser.keys("End");
        const last = await text("metrics-chart-cpu-readout");
        await browser.keys("ArrowLeft");
        const earlier = await text("metrics-chart-cpu-readout");
        return last !== "" && earlier !== "" && earlier !== last;
      },
      "Left never moved the CPU readout to an earlier sample",
      180_000,
    );
  });

  it("a Pod's drawer shows CPU, Memory and Network under Metrics", async function () {
    this.timeout(SAMPLES_TIMEOUT + 2 * 60_000);
    const pod = (
      await kubectl([
        "-n",
        prometheus.namespace,
        "get",
        "pods",
        "-l",
        PROMETHEUS_SERVER_SELECTOR,
        "-o",
        "jsonpath={.items[0].metadata.name}",
      ])
    ).trim();
    await openResource(PODS, "Pod");
    await searchResources(pod);
    await clickWhenShown(rowId(prometheus.namespace, pod));
    await shown("detail-drawer");
    await pointerClick(await shown("detail-tab-metrics"));
    await until(
      () => chartsHaveData(["cpu", "memory", "network"]),
      "the Pod's CPU, Memory and Network charts never showed data",
      SAMPLES_TIMEOUT,
    );
    await clickWhenShown("detail-close");
    await gone("detail-drawer");
  });

  it("Detect finds a Prometheus Service by itself", async () => {
    await saveProvider("auto");
    await openOverview();
    await until(
      async () =>
        /^Prometheus \S+\/\S+:\d+, autodetected, through the API server proxy$/.test(
          await text("metrics-source"),
        ),
      "the source line never named an autodetected Prometheus",
    );
  });

  it("metrics-server only: the Live badge, then CPU and memory in the Pods table within 45 s", async () => {
    await saveProvider("metricsServer");
    await openOverview();
    await shown("metrics-live-badge", 30_000);
    await until(
      async () =>
        (await text("metrics-source")) ===
        "metrics-server, set in the cluster settings. Samples every 15 s while the cluster is connected",
      "the source line never named metrics-server",
    );

    await openResource(PODS, "Pod");
    await until(
      async () =>
        (await usageCells("usage-cpu")).some((cell) => /^\d+m$/.test(cell)) &&
        (await usageCells("usage-memory")).some((cell) =>
          /^(\d+Mi|\d+\.\dGi)$/.test(cell),
        ),
      "the Pods table never showed CPU and memory values",
      USAGE_TIMEOUT,
    );
  });

  it("the Keyboard shortcuts dialog lists the Charts group", async () => {
    await browser.keys(["Control", "/"]);
    const dialog = await shown("shortcuts-dialog");
    await shown("shortcut-chartSample");
    await shown("shortcut-chartEnds");
    await shown("shortcut-chartHide");
    const all = await dialog.getText();
    expect(all).toContain("Charts");
    expect(all).toContain("Previous or next sample");
    await browser.keys("Escape");
    await gone("shortcuts-dialog");
  });
});
