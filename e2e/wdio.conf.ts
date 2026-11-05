import path from "node:path";
import { prepareAppEnv } from "./helpers/env";

const root = path.resolve(__dirname, "..");
const exe = process.platform === "win32" ? "sextant-app.exe" : "sextant-app";
const specSet = process.env.SEXTANT_E2E_SPEC_SET ?? "full";

export const config = {
  runner: "local",
  specs: specSet === "smoke" ? ["./specs/smoke/**/*.e2e.ts"] : ["./specs/**/*.e2e.ts"],
  exclude: specSet === "smoke" ? [] : ["./specs/smoke/**"],
  maxInstances: 1,
  services: [["@wdio/tauri-service", { driverProvider: "embedded" }]],
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
    prepareAppEnv({});
  },
};
