import type { PortForward } from "../ipc/generated/PortForward";

/** A port forward with what a test does not care about filled in. */
export function forward(
  over: Partial<PortForward> & { id: string },
): PortForward {
  return {
    state: "stopped",
    boundPort: null,
    message: null,
    activeConnections: 0,
    clusterId: "c1",
    target: { kind: "service", namespace: "shop", name: "web" },
    targetPort: 80,
    localPort: null,
    ...over,
  };
}
