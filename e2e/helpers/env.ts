import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface AppEnv {
  home: string;
  configDir: string;
}

/**
 * Creates temp HOME and config dirs, writes each given kubeconfig under
 * `<home>/.kube/`, and points the process environment at them before launch.
 * `prefs` fields, such as `helmPath`, are saved as the app's preferences, next to
 * the theme and the `<home>/.kube` source a first run would choose.
 */
export function prepareAppEnv(opts: {
  kubeconfigs?: Record<string, string>;
  prefs?: Record<string, unknown>;
}): AppEnv {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "skopos-e2e-home-"));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "skopos-e2e-config-"));
  const kubeDir = path.join(home, ".kube");
  fs.mkdirSync(kubeDir, { recursive: true });
  for (const [name, content] of Object.entries(opts.kubeconfigs ?? {})) {
    fs.writeFileSync(path.join(kubeDir, name), content);
  }
  if (opts.prefs) {
    const data = {
      theme: "system",
      syncSources: [{ kind: "dir", path: kubeDir }],
      ...opts.prefs,
    };
    fs.mkdirSync(path.join(configDir, "config"), { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config", "prefs.json"),
      JSON.stringify({ version: 1, data }),
    );
  }
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.SKOPOS_CONFIG_DIR = configDir;
  delete process.env.KUBECONFIG;
  return { home, configDir };
}
