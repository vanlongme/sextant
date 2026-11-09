import { expect, test } from "vitest";
import { forward } from "../../test/portForwards";
import {
  kindLabel,
  localAddress,
  localText,
  portText,
  runningText,
  STATE_LOOK,
  targetText,
} from "./forwardText";

test("each state has its tone and label", () => {
  expect(STATE_LOOK).toEqual({
    running: { tone: "ok", label: "Running" },
    starting: { tone: "warn", label: "Starting" },
    failed: { tone: "danger", label: "Failed" },
    stopped: { tone: "neutral", label: "Stopped" },
  });
});

test("the target reads kind/name, and its kind and port as they are", () => {
  const pod = forward({
    id: "a",
    target: { kind: "pod", namespace: "shop", name: "web-1" },
    targetPort: "http",
  });
  expect(targetText(pod)).toBe("pod/web-1");
  expect(kindLabel(pod)).toBe("Pod");
  expect(portText(pod)).toBe("http");
  const service = forward({ id: "b", targetPort: 8080 });
  expect(targetText(service)).toBe("service/web");
  expect(kindLabel(service)).toBe("Service");
  expect(portText(service)).toBe("8080");
});

test("Local reads the bound port, else the chosen port, else random", () => {
  expect(
    localText(forward({ id: "a", boundPort: 50123, localPort: 8080 })),
  ).toBe("127.0.0.1:50123");
  expect(localText(forward({ id: "a", localPort: 8080 }))).toBe(
    "127.0.0.1:8080",
  );
  expect(localText(forward({ id: "a" }))).toBe("random");
});

test("the drawer's local address says how it will be chosen", () => {
  expect(
    localAddress(forward({ id: "a", boundPort: 50123, localPort: 8080 })),
  ).toBe("127.0.0.1:50123");
  expect(localAddress(forward({ id: "a", localPort: 8080 }))).toBe(
    "127.0.0.1:8080 when it runs",
  );
  expect(localAddress(forward({ id: "a" }))).toBe(
    "A random free port when it runs",
  );
});

test("the status bar text for 0, 1 and 2 running", () => {
  expect(runningText(0)).toBeNull();
  expect(runningText(1)).toBe("1 port forward running");
  expect(runningText(2)).toBe("2 port forwards running");
});
