import { expect, test } from "vitest";
import { containerChoices } from "./podContainers";

test("the choices are the Pod's containers, a waiting one with its reason", () => {
  expect(
    containerChoices({
      metadata: { name: "web-1", namespace: "shop" },
      spec: {
        initContainers: [{ name: "setup" }],
        containers: [{ name: "app" }, { name: "sidecar" }, { name: "proxy" }],
        ephemeralContainers: [{ name: "debugger" }],
      },
      status: {
        containerStatuses: [
          { name: "app", state: { waiting: { reason: "CrashLoopBackOff" } } },
          { name: "sidecar", state: { running: {} } },
          { name: "proxy", state: { waiting: {} } },
        ],
      },
    }),
  ).toEqual([
    { value: "app", label: "app (CrashLoopBackOff)" },
    { value: "sidecar", label: "sidecar" },
    { value: "proxy", label: "proxy" },
  ]);
});

test("there are no choices before the Pod row is there", () => {
  expect(containerChoices(undefined)).toEqual([]);
  expect(containerChoices({ metadata: { name: "web-1" } })).toEqual([]);
});
