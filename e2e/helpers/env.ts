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
 */
export function prepareAppEnv(opts: { kubeconfigs?: Record<string, string> }): AppEnv {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "skopos-e2e-home-"));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "skopos-e2e-config-"));
  const kubeDir = path.join(home, ".kube");
  fs.mkdirSync(kubeDir, { recursive: true });
  for (const [name, content] of Object.entries(opts.kubeconfigs ?? {})) {
    fs.writeFileSync(path.join(kubeDir, name), content);
  }
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.SKOPOS_CONFIG_DIR = configDir;
  delete process.env.KUBECONFIG;
  return { home, configDir };
}
