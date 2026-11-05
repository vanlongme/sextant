import path from "node:path";

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
}

const FIXTURES: Record<string, SpecFixture> = {
  catalog: { kubeconfigs: { config: kubeconfig(["alpha", "beta"]) } },
  "hotbar-restart-1-save": {
    kubeconfigs: { config: kubeconfig(["alpha", "beta"]) },
    envGroup: "hotbar-restart",
  },
  "hotbar-restart-2-verify": { kubeconfigs: {}, envGroup: "hotbar-restart" },
};

/** Specs with no entry start with an empty `~/.kube`. */
export function fixtureFor(specFile: string): SpecFixture {
  const name = path.basename(specFile.replace(/^file:\/\//, ""), ".e2e.ts");
  return FIXTURES[name] ?? { kubeconfigs: {} };
}
