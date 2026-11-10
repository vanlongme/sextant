import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
/** Where `make test-kind` keeps the managed helm it downloads. */
const MANAGED_TOOLS = path.join(REPO_ROOT, "e2e", ".tmp", "tools", "data", "tools", "helm");
const FIXTURE_CHART = path.join(
  REPO_ROOT,
  "crates",
  "skopos-core",
  "tests",
  "fixtures",
  "helm",
  "skopos-fixture",
);
const HELM_BINARY = process.platform === "win32" ? "helm.exe" : "helm";

function onPath(): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir === "") continue;
    const candidate = path.join(dir, HELM_BINARY);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not in this folder.
    }
  }
  return null;
}

function managed(): string | null {
  if (!fs.existsSync(MANAGED_TOOLS)) return null;
  for (const version of fs.readdirSync(MANAGED_TOOLS).sort().reverse()) {
    const candidate = path.join(MANAGED_TOOLS, version, HELM_BINARY);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * helm on PATH, or else the managed copy `make test-kind` downloads. It throws when
 * neither exists, so the spec fails instead of skipping.
 */
export function findHelm(): { path: string; onPath: boolean } {
  const found = onPath();
  if (found) return { path: found, onPath: true };
  const copy = managed();
  if (copy) return { path: copy, onPath: false };
  throw new Error(
    `helm is not on PATH and ${MANAGED_TOOLS} holds no copy: run make test-kind once, or install helm`,
  );
}

function run(helm: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(helm, args, { env }, (error, _stdout, stderr) => {
      if (error) reject(new Error(`helm ${args.join(" ")}: ${stderr || error.message}`));
      else resolve();
    });
  });
}

/**
 * Packages the backend's fixture chart as 0.1.0 (app 1.0.0) and 0.2.0 (app 1.1.0),
 * indexes it and serves the folder on 127.0.0.1. helm's own folders go to a temp dir,
 * so the user's helm setup is not touched.
 */
export async function serveFixtureCharts(
  helm: string,
): Promise<{ url: string; close(): Promise<void> }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skopos-e2e-charts-"));
  const charts = path.join(dir, "charts");
  fs.mkdirSync(charts);
  const env = {
    ...process.env,
    HELM_CONFIG_HOME: path.join(dir, "config"),
    HELM_CACHE_HOME: path.join(dir, "cache"),
    HELM_DATA_HOME: path.join(dir, "data"),
  };
  for (const [version, appVersion] of [
    ["0.1.0", "1.0.0"],
    ["0.2.0", "1.1.0"],
  ]) {
    await run(
      helm,
      [
        "package",
        FIXTURE_CHART,
        "--version",
        version,
        "--app-version",
        appVersion,
        "--destination",
        charts,
      ],
      env,
    );
  }
  const server = http.createServer((req, res) => {
    const name = path.basename(decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/"));
    const file = path.join(charts, name);
    if (name === "" || !fs.existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200).end(fs.readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  await run(helm, ["repo", "index", charts, "--url", url], env);
  return {
    url,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
