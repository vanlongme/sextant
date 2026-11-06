import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** The kubeconfig of the kind cluster, which `scripts/kind-up.sh` writes. */
const KIND_KUBECONFIG = path.resolve(__dirname, "..", ".tmp", "kubeconfig");
const TEST_NAMESPACE_PREFIX = "sextant-test-";
const OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;
const NAMESPACE_DELETE_TIMEOUT = "120s";

/**
 * Runs kubectl against the kind cluster and gives its stdout. It always passes
 * that cluster's kubeconfig, and refuses to run without it, so no spec can reach
 * another cluster.
 */
export function kubectl(args: string[], input?: string): Promise<string> {
  if (!fs.existsSync(KIND_KUBECONFIG)) {
    return Promise.reject(
      new Error(`${KIND_KUBECONFIG} is missing: run scripts/kind-up.sh first`),
    );
  }
  return new Promise((resolve, reject) => {
    const child = execFile(
      "kubectl",
      ["--kubeconfig", KIND_KUBECONFIG, ...args],
      { maxBuffer: OUTPUT_LIMIT_BYTES },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(`kubectl ${args.join(" ")}: ${stderr || error.message}`),
          );
        } else {
          resolve(stdout);
        }
      },
    );
    child.stdin?.end(input ?? "");
  });
}

function assertTestNamespace(name: string): void {
  if (!name.startsWith(TEST_NAMESPACE_PREFIX)) {
    throw new Error(
      `${name} is not a test namespace: it must start with ${TEST_NAMESPACE_PREFIX}`,
    );
  }
}

/** Removes a test namespace and waits until it is gone. Absent is fine. */
export async function deleteTestNamespace(name: string): Promise<void> {
  assertTestNamespace(name);
  await kubectl([
    "delete",
    "namespace",
    name,
    "--ignore-not-found",
    "--wait=true",
    `--timeout=${NAMESPACE_DELETE_TIMEOUT}`,
  ]);
}

/** Creates a test namespace, replacing what an interrupted run may have left. */
export async function createTestNamespace(name: string): Promise<void> {
  await deleteTestNamespace(name);
  await kubectl(["create", "namespace", name]);
}
