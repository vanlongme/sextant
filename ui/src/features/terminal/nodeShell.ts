import { api } from "../../ipc/api";

/** The backend's image when the cluster sets none. */
export const NODE_SHELL_DEFAULT_IMAGE = "alpine:3.22";

/**
 * The image the backend will use for the node shell Pod: the cluster's `nodeShellImage`,
 * or `alpine:3.22` when it is empty or the settings cannot be read.
 */
export async function nodeShellImage(clusterId: string): Promise<string> {
  try {
    const { nodeShellImage: image } = await api.clusterSettingsGet(clusterId);
    return image === null || image === "" ? NODE_SHELL_DEFAULT_IMAGE : image;
  } catch {
    return NODE_SHELL_DEFAULT_IMAGE;
  }
}

export interface NodeShellPrompt {
  title: string;
  body: string;
  confirmLabel: string;
}

/** The confirmation before each node shell start (spec §4.2). */
export function nodeShellPrompt(node: string, image: string): NodeShellPrompt {
  return {
    title: `Open a root shell on ${node}?`,
    body: `SkoposIDE creates a privileged Pod (image ${image}, host PID namespace) in kube-system on ${node} and enters the node with nsenter. Anything you run changes the node itself. The Pod is deleted when you close the tab.`,
    confirmLabel: "Open shell",
  };
}
