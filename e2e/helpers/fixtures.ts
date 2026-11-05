import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeKube } from "./fakekube";

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
  start?: () => Promise<{ kubeconfigs: Record<string, string>; stop(): Promise<void> }>;
}

const KIND_KUBECONFIG = path.resolve(__dirname, "..", ".tmp", "kubeconfig");

/** One file each for the kind cluster, a fakekube context and a dead one. */
async function startConnectionFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-e2e-fake-"));
  const fakePath = path.join(dir, "fake");
  const fake = await startFakeKube({ kubeconfigPath: fakePath, context: "fake" });
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sextant-e2e-smoke-"));
  const fakePath = path.join(dir, "fake");
  const fake = await startFakeKube({ kubeconfigPath: fakePath, context: "fake" });
  return {
    kubeconfigs: { fake: fs.readFileSync(fakePath, "utf8") },
    async stop() {
      await fake.stop();
      fs.rmSync(dir, { recursive: true, force: true });
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
};

/** Specs with no entry start with an empty `~/.kube`. */
export function fixtureFor(specFile: string): SpecFixture {
  const name = path.basename(specFile.replace(/^file:\/\//, ""), ".e2e.ts");
  return FIXTURES[name] ?? { kubeconfigs: {} };
}
