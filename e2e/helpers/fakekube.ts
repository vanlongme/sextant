import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";

const BINARY = path.resolve(__dirname, "..", "..", "target", "debug", "sextant-fakekube");
const START_TIMEOUT_MS = 15000;

/**
 * Spawns `target/debug/sextant-fakekube`, which writes a kubeconfig with the
 * given context to `kubeconfigPath` and serves a fake API server until stopped.
 */
export async function startFakeKube(opts: {
  kubeconfigPath: string;
  context: string;
}): Promise<{ url: string; stop(): Promise<void> }> {
  const child: ChildProcess = spawn(
    BINARY,
    ["--kubeconfig", opts.kubeconfigPath, "--context", opts.context],
    { stdio: ["ignore", "pipe", "inherit"] },
  );

  const url = await new Promise<string>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(
      () => reject(new Error("sextant-fakekube did not report its address")),
      START_TIMEOUT_MS,
    );
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`sextant-fakekube exited with ${code} before it was ready`));
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const found = /listening on (\S+)/.exec(out);
      if (found?.[1]) {
        clearTimeout(timer);
        resolve(found[1]);
      }
    });
  });

  return {
    url,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGINT");
      await exited;
    },
  };
}
