import fs from "node:fs";
import path from "node:path";
import { launcher as TauriLauncher } from "@wdio/tauri-service";
import { stopApp } from "./helpers/app";
import { type AppEnv, prepareAppEnv } from "./helpers/env";
import { fixtureFor } from "./helpers/fixtures";

const root = path.resolve(__dirname, "..");
const exe = process.platform === "win32" ? "skopos-app.exe" : "skopos-app";
const specSet = process.env.SKOPOS_E2E_SPEC_SET ?? "full";

const envs: AppEnv[] = [];
const envGroups = new Map<string, AppEnv>();

const stops: Array<() => Promise<void>> = [];

function createEnv(kubeconfigs: Record<string, string>): AppEnv {
  const env = prepareAppEnv({ kubeconfigs });
  envs.push(env);
  return env;
}

function useEnv(env: AppEnv): void {
  process.env.HOME = env.home;
  process.env.USERPROFILE = env.home;
  process.env.SKOPOS_CONFIG_DIR = env.configDir;
}

/** The temp env for a spec file: a new one, or the one its group already has. */
async function envForSpec(spec: string): Promise<AppEnv> {
  const fixture = fixtureFor(spec);
  const shared = fixture.envGroup && envGroups.get(fixture.envGroup);
  if (shared) {
    useEnv(shared);
    return shared;
  }
  let kubeconfigs = fixture.kubeconfigs;
  if (fixture.start) {
    const started = await fixture.start();
    stops.push(started.stop);
    kubeconfigs = { ...kubeconfigs, ...started.kubeconfigs };
  }
  const env = createEnv(kubeconfigs);
  if (fixture.envGroup) envGroups.set(fixture.envGroup, env);
  return env;
}

export const config = {
  runner: "local",
  specs: specSet === "smoke" ? ["./specs/smoke/**/*.e2e.ts"] : ["./specs/**/*.e2e.ts"],
  exclude: specSet === "smoke" ? [] : ["./specs/smoke/**"],
  maxInstances: 1,
  // Launcher half only. The worker half needs `browser.executeAsync`, which
  // webdriverio 10 removed: it fails in `before()` and then delays every element
  // command by 5 s waiting for an API that never appears. No spec uses `browser.tauri`.
  services: [[TauriLauncher, { driverProvider: "embedded" }]],
  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": { application: path.join(root, "target", "debug", exe) },
    },
  ],
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { ui: "bdd", timeout: 120000 },
  onPrepare() {
    // The service starts an app right after this hook, before any spec is
    // known. It only needs a safe environment; onWorkerStart replaces it.
    createEnv({});
  },
  // Runs before the service's own hook, which starts a new app when none is
  // running, and before the worker is forked. So the app and the spec both get
  // the environment set here: one app and one env per spec file.
  async onWorkerStart(_cid: string, _caps: unknown, specs: string[]) {
    await stopApp();
    const env = await envForSpec(specs[0] ?? "");
    process.env.SKOPOS_E2E_HOME = env.home;
  },
  async onComplete() {
    for (const stop of stops) await stop();
    for (const env of envs) {
      fs.rmSync(env.home, { recursive: true, force: true });
      fs.rmSync(env.configDir, { recursive: true, force: true });
    }
  },
};
