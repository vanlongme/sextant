import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { findHelm } from "./helmCharts";
import { kubectl } from "./kube";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
/** The kubeconfig of the kind cluster, which `scripts/kind-up.sh` writes. */
const KIND_KUBECONFIG = path.join(REPO_ROOT, "e2e", ".tmp", "kubeconfig");
const METRICS_UP = path.join(REPO_ROOT, "scripts", "metrics-up.sh");
const VALUES = path.join(REPO_ROOT, "e2e", "fixtures", "prometheus-values.yaml");
/** helm's own folders, so the user's helm setup is not touched; the chart cache stays for the next run. */
const HELM_HOME = path.join(REPO_ROOT, "e2e", ".tmp", "helm-metrics");
const CHART_REPO = "https://prometheus-community.github.io/helm-charts";
const CHART_VERSION = "29.45.1";
const OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;

export const PROMETHEUS_NAMESPACE = "skopos-e2e-metrics";
export const PROMETHEUS_RELEASE = "skopos-e2e-prometheus";
/** The chart's server Deployment, Pod and Service. */
export const PROMETHEUS_SERVER_SELECTOR = [
  `app.kubernetes.io/instance=${PROMETHEUS_RELEASE}`,
  "app.kubernetes.io/name=prometheus",
  "app.kubernetes.io/component=server",
].join(",");

export interface PrometheusService {
  namespace: string;
  service: string;
  port: number;
}

function run(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { cwd: REPO_ROOT, env, maxBuffer: OUTPUT_LIMIT_BYTES },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `${path.basename(file)} ${args.join(" ")}: ${stderr || error.message}`,
            ),
          );
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

function helmEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HELM_CACHE_HOME: path.join(HELM_HOME, "cache"),
    HELM_CONFIG_HOME: path.join(HELM_HOME, "config"),
    HELM_DATA_HOME: path.join(HELM_HOME, "data"),
  };
}

async function metricsServerServed(): Promise<boolean> {
  try {
    const status = await kubectl([
      "get",
      "apiservice",
      "v1beta1.metrics.k8s.io",
      "-o",
      'jsonpath={.status.conditions[?(@.type=="Available")].status}',
    ]);
    return status.trim() === "True";
  } catch {
    // Not registered yet.
    return false;
  }
}

/** The release's status, such as "deployed" or "failed", or null when there is none. */
async function releaseStatus(helm: string): Promise<string | null> {
  try {
    const out = await run(
      helm,
      [
        "status",
        PROMETHEUS_RELEASE,
        "-n",
        PROMETHEUS_NAMESPACE,
        "--kubeconfig",
        KIND_KUBECONFIG,
        "-o",
        "json",
      ],
      helmEnv(),
    );
    const release = JSON.parse(out) as { info?: { status?: string } };
    return release.info?.status ?? null;
  } catch {
    // helm status fails when the release does not exist.
    return null;
  }
}

async function ensurePrometheus(): Promise<void> {
  const helm = findHelm().path;
  const status = await releaseStatus(helm);
  if (status === "deployed") return;
  fs.mkdirSync(HELM_HOME, { recursive: true });
  if (status !== null) {
    // A failed or interrupted install: start again from nothing.
    await run(
      helm,
      [
        "uninstall",
        PROMETHEUS_RELEASE,
        "-n",
        PROMETHEUS_NAMESPACE,
        "--kubeconfig",
        KIND_KUBECONFIG,
        "--wait",
      ],
      helmEnv(),
    );
  }
  await run(
    helm,
    [
      "install",
      PROMETHEUS_RELEASE,
      "prometheus",
      "--repo",
      CHART_REPO,
      "--version",
      CHART_VERSION,
      "-n",
      PROMETHEUS_NAMESPACE,
      "--create-namespace",
      "-f",
      VALUES,
      "--wait",
      "--timeout",
      "10m",
      "--kubeconfig",
      KIND_KUBECONFIG,
    ],
    helmEnv(),
  );
}

/** The server's Service, with its port named "http", else its first port. */
async function serverService(): Promise<PrometheusService> {
  const out = await kubectl([
    "-n",
    PROMETHEUS_NAMESPACE,
    "get",
    "services",
    "-l",
    PROMETHEUS_SERVER_SELECTOR,
    "-o",
    "json",
  ]);
  const list = JSON.parse(out) as {
    items: {
      metadata: { name: string };
      spec: { ports?: { name?: string; port: number }[] };
    }[];
  };
  const service = list.items[0];
  if (!service) {
    throw new Error(
      `no Service matches ${PROMETHEUS_SERVER_SELECTOR} in ${PROMETHEUS_NAMESPACE}`,
    );
  }
  const ports = service.spec.ports ?? [];
  const port = ports.find((p) => p.name === "http") ?? ports[0];
  if (!port) throw new Error(`${service.metadata.name} has no port`);
  return {
    namespace: PROMETHEUS_NAMESPACE,
    service: service.metadata.name,
    port: port.port,
  };
}

/**
 * Makes sure the kind cluster serves metrics.k8s.io (metrics-server, through
 * `scripts/metrics-up.sh`) and runs the prometheus-community chart in
 * `skopos-e2e-metrics`, skipping what is already there, and gives the Prometheus
 * server's Service. Needs the network the first time. Both stay installed for the
 * next run.
 */
export async function ensureMetricsProviders(): Promise<PrometheusService> {
  if (!(await metricsServerServed())) await run("bash", [METRICS_UP]);
  await ensurePrometheus();
  await kubectl([
    "-n",
    PROMETHEUS_NAMESPACE,
    "wait",
    "--for=condition=Available",
    "deployment",
    "-l",
    PROMETHEUS_SERVER_SELECTOR,
    "--timeout=600s",
  ]);
  return serverService();
}
