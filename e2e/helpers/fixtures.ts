import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeKube } from "./fakekube";
import { findHelm } from "./helmCharts";
import { kubectl } from "./kube";

/** Unreachable, so nothing in these specs ever depends on a live cluster. */
const DEAD_SERVER = "http://127.0.0.1:1";

/** A kubeconfig with one context per name, all pointing at `server`. */
export function kubeconfig(contexts: string[], server = DEAD_SERVER): string {
  const items = (section: string, body: (name: string) => string[]) =>
    [
      `${section}:`,
      ...contexts.flatMap((name) => [`- name: ${name}`, ...body(name)]),
    ].join("\n");
  return `${[
    "apiVersion: v1",
    "kind: Config",
    items("clusters", () => ["  cluster:", `    server: ${server}`]),
    items("users", () => ["  user:", "    token: e2e-token"]),
    items("contexts", (name) => [
      "  context:",
      `    cluster: ${name}`,
      `    user: ${name}`,
    ]),
  ].join("\n")}\n`;
}

export interface SpecFixture {
  /** Files written under `<home>/.kube/` before the app starts. */
  kubeconfigs: Record<string, string>;
  /** Specs in one group share a temp HOME and config dir, so a later spec sees what an earlier one saved. */
  envGroup?: string;
  /**
   * Starts what the spec needs before the app does, such as a fake API server,
   * and returns the kubeconfigs it wants written, with a way to stop it.
   */
  start?: () => Promise<{
    kubeconfigs: Record<string, string>;
    /** Saved as the app's preferences before it starts; see `prepareAppEnv`. */
    prefs?: Record<string, unknown>;
    stop(): Promise<void>;
  }>;
}

const KIND_KUBECONFIG = path.resolve(__dirname, "..", ".tmp", "kubeconfig");

/** One file each for the kind cluster, a fakekube context and a dead one. */
async function startConnectionFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skopos-e2e-fake-"));
  const fakePath = path.join(dir, "fake");
  const fake = await startFakeKube({
    kubeconfigPath: fakePath,
    context: "fake",
  });
  return {
    kubeconfigs: {
      kind: fs.readFileSync(KIND_KUBECONFIG, "utf8"),
      fake: fs.readFileSync(fakePath, "utf8"),
      dead: kubeconfig(["dead"]),
    },
    async stop() {
      await fake.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** One fakekube context and nothing else, so it needs no Docker. */
async function startSmokeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skopos-e2e-smoke-"));
  const fakePath = path.join(dir, "fake");
  const fake = await startFakeKube({
    kubeconfigPath: fakePath,
    context: "fake",
  });
  return {
    kubeconfigs: { fake: fs.readFileSync(fakePath, "utf8") },
    async stop() {
      await fake.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The kind cluster and nothing else. */
async function startKindFixture() {
  return {
    kubeconfigs: { kind: fs.readFileSync(KIND_KUBECONFIG, "utf8") },
    async stop() {},
  };
}

/**
 * The kind cluster, and helm: on PATH it needs nothing more, else the managed copy
 * is set as `helmPath` in the preferences. `findHelm` throws when there is neither.
 */
async function startHelmFixture() {
  const helm = findHelm();
  return {
    kubeconfigs: { kind: fs.readFileSync(KIND_KUBECONFIG, "utf8") },
    prefs: helm.onPath ? undefined : { helmPath: helm.path },
    async stop() {},
  };
}

const MAP_NAMESPACE = "skopos-e2e-map";
const MAP_OBJECTS = path.resolve(__dirname, "..", "fixtures", "map.yaml");
const GATEWAY_API_CRDS =
  "https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.7.0/standard-install.yaml";

/**
 * The kind cluster with the resource map's objects (spec E §18.3). The graph reads
 * discovery once, when it starts, so the Gateway API CRDs and the objects are in
 * place before the app connects. The CRDs stay installed, as the backend's kind
 * test leaves them; the namespace is deleted when the run ends.
 */
async function startMapFixture() {
  await kubectl([
    "apply",
    "--server-side",
    "--force-conflicts",
    "--field-manager=skopos-e2e",
    "-f",
    GATEWAY_API_CRDS,
  ]);
  await kubectl([
    "wait",
    "--for=condition=Established",
    "--timeout=60s",
    "crd/gatewayclasses.gateway.networking.k8s.io",
    "crd/gateways.gateway.networking.k8s.io",
    "crd/httproutes.gateway.networking.k8s.io",
  ]);
  await kubectl([
    "delete",
    "namespace",
    MAP_NAMESPACE,
    "--ignore-not-found",
    "--wait=true",
    "--timeout=120s",
  ]);
  await kubectl(["apply", "-f", MAP_OBJECTS]);
  await kubectl([
    "-n",
    MAP_NAMESPACE,
    "rollout",
    "status",
    "deployment/web",
    "--timeout=120s",
  ]);
  return {
    kubeconfigs: { kind: fs.readFileSync(KIND_KUBECONFIG, "utf8") },
    async stop() {
      await kubectl([
        "delete",
        "namespace",
        MAP_NAMESPACE,
        "--ignore-not-found",
        "--wait=false",
      ]);
    },
  };
}

const FIXTURES: Record<string, SpecFixture> = {
  catalog: { kubeconfigs: { config: kubeconfig(["alpha", "beta"]) } },
  "hotbar-restart-1-save": {
    kubeconfigs: { config: kubeconfig(["alpha", "beta"]) },
    envGroup: "hotbar-restart",
  },
  "hotbar-restart-2-verify": { kubeconfigs: {}, envGroup: "hotbar-restart" },
  connection: { kubeconfigs: {}, start: startConnectionFixture },
  smoke: { kubeconfigs: {}, start: startSmokeFixture },
  resources: { kubeconfigs: {}, start: startKindFixture },
  editor: { kubeconfigs: {}, start: startKindFixture },
  crd: { kubeconfigs: {}, start: startKindFixture },
  kinds: { kubeconfigs: {}, start: startKindFixture },
  "config-kinds": { kubeconfigs: {}, start: startKindFixture },
  drain: { kubeconfigs: {}, start: startKindFixture },
  actions: { kubeconfigs: {}, start: startKindFixture },
  logs: { kubeconfigs: {}, start: startKindFixture },
  "dock-restart-1-save": {
    kubeconfigs: {},
    envGroup: "dock-restart",
    start: startKindFixture,
  },
  "dock-restart-2-verify": { kubeconfigs: {}, envGroup: "dock-restart" },
  terminal: { kubeconfigs: {}, start: startKindFixture },
  "terminal-restart-1-save": {
    kubeconfigs: {},
    envGroup: "terminal-restart",
    start: startKindFixture,
  },
  "terminal-restart-2-verify": { kubeconfigs: {}, envGroup: "terminal-restart" },
  "port-forward": { kubeconfigs: {}, start: startKindFixture },
  "app-shell": { kubeconfigs: {}, start: startKindFixture },
  "port-forward-restart-1-save": {
    kubeconfigs: {},
    envGroup: "port-forward-restart",
    start: startKindFixture,
  },
  "port-forward-restart-2-verify": {
    kubeconfigs: {},
    envGroup: "port-forward-restart",
  },
  screens: { kubeconfigs: {}, start: startKindFixture },
  helm: { kubeconfigs: {}, start: startHelmFixture },
  // e2e/helpers/metrics.ts installs the providers in the spec, which needs a longer timeout.
  metrics: { kubeconfigs: {}, start: startKindFixture },
  map: { kubeconfigs: {}, start: startMapFixture },
};

/** Specs with no entry start with an empty `~/.kube`. */
export function fixtureFor(specFile: string): SpecFixture {
  const name = path.basename(specFile.replace(/^file:\/\//, ""), ".e2e.ts");
  return FIXTURES[name] ?? { kubeconfigs: {} };
}
