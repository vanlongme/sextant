import { expect, test } from "vitest";
import { mockBackend } from "../../test/ipc";
import {
  NODE_SHELL_DEFAULT_IMAGE,
  nodeShellImage,
  nodeShellPrompt,
} from "./nodeShell";

test.each<[string, string | null, string]>([
  ["the cluster's setting", "busybox:1.37", "busybox:1.37"],
  ["alpine:3.22 without a setting", null, "alpine:3.22"],
  ["alpine:3.22 when the setting is empty", "", "alpine:3.22"],
])("the node shell image is %s", async (_name, setting, image) => {
  const backend = mockBackend({
    cluster_settings_get: () => ({ nodeShellImage: setting }),
  });
  await expect(nodeShellImage("c1")).resolves.toBe(image);
  expect(backend.callsTo("cluster_settings_get")).toEqual([{ id: "c1" }]);
});

test("the node shell image is alpine:3.22 when the settings cannot be read", async () => {
  mockBackend({
    cluster_settings_get: () => {
      throw new Error("the settings file cannot be read");
    },
  });
  expect(NODE_SHELL_DEFAULT_IMAGE).toBe("alpine:3.22");
  await expect(nodeShellImage("c1")).resolves.toBe("alpine:3.22");
});

test("the prompt names the node and the image", () => {
  expect(nodeShellPrompt("worker-1", "busybox:1.37")).toEqual({
    title: "Open a root shell on worker-1?",
    body: "SkoposIDE creates a privileged Pod (image busybox:1.37, host PID namespace) in kube-system on worker-1 and enters the node with nsenter. Anything you run changes the node itself. The Pod is deleted when you close the tab.",
    confirmLabel: "Open shell",
  });
});
